// End-to-end: ask over HTTP -> retrieval -> (fake) LLM -> verified citations -> stored message.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { buildApp } from '../app.ts';
import { FakeEmbedder } from '../llm/embedder.ts';
import { FakeLlm } from '../llm/fake-llm.ts';
import type { GenerateRequest } from '../llm/provider.ts';
import { createTestDb } from '../test/db.ts';
import { testConfig } from '../test/config.ts';
import { signUp } from '../test/http.ts';
import { seedDocument } from '../test/seed.ts';
import { CITATIONS_DELIMITER } from './prompt.ts';

// Behaves like a well-instructed model: answers from source 1 with a real quote, plus one
// fabricated citation to source 2 (which must be rejected). Rewrites follow-ups when asked.
const scriptedModel = (req: GenerateRequest) => {
  if (req.tier === 'fast') return 'How many layers does the decoder have?';
  const last = req.messages.at(-1)!.text;
  const first = /<source id="1"[^>]*>\n([^\n]+)/.exec(last)?.[1] ?? '';
  const quote = first.split('. ')[0]!;
  return `Answer based on the sources [1]. Also a made-up claim [2].\n${CITATIONS_DELIMITER}\n` +
    `${JSON.stringify({ source: 1, quote })}\n${JSON.stringify({ source: 2, quote: 'this text appears nowhere' })}`;
};

// Parses a finished SSE body into [{event, data}].
const parseSse = (body: string) =>
  body.split('\n\n').map((block) => {
    const event = /^event: (.+)$/m.exec(block)?.[1];
    const data = /^data: (.+)$/m.exec(block)?.[1];
    return event && data ? { event, data: JSON.parse(data) } : null;
  }).filter((e): e is { event: string; data: any } => e !== null);

describe('chat', () => {
  let pool: pg.Pool;
  let app: Awaited<ReturnType<typeof buildApp>>;
  const llm = new FakeLlm(scriptedModel);

  before(async () => {
    pool = await createTestDb();
    app = await buildApp(testConfig(), { db: pool, embedder: new FakeEmbedder(), llm });
  });
  after(async () => {
    await app.close();
    await pool.end();
  });

  const setup = async () => {
    const cookies = await signUp(app);
    const me = (await app.inject({ method: 'GET', url: '/me', cookies })).json().user;
    const docId = await seedDocument(pool, me.id, 'Attention paper', [
      'The encoder is composed of a stack of N = 6 identical layers. Each has two sub-layers.',
      'The decoder is also composed of a stack of N = 6 identical layers.',
      'We used the Adam optimizer with a warmup schedule.',
    ]);
    const conv = (await app.inject({ method: 'POST', url: '/conversations', cookies })).json().conversation;
    return { cookies, me, docId, conv };
  };
  const ask = (cookies: Record<string, string>, convId: string, question: string) =>
    app.inject({ method: 'POST', url: `/conversations/${convId}/ask`, cookies, payload: { question } });

  test('streams status, sources, tokens and a done event with only verified citations', async () => {
    const { cookies, conv } = await setup();
    const res = await ask(cookies, conv.id, 'How many layers does the encoder have?');
    assert.equal(res.headers['content-type'], 'text/event-stream; charset=utf-8');

    const events = parseSse(res.body);
    const kinds = events.map((e) => e.event);
    assert.ok(kinds.indexOf('sources') < kinds.indexOf('token'), 'sources arrive before the answer');
    assert.equal(kinds.at(-1), 'done');

    const streamed = events.filter((e) => e.event === 'token').map((e) => e.data.text).join('');
    assert.ok(!streamed.includes(CITATIONS_DELIMITER), 'protocol text never reaches the user');

    const done = events.at(-1)!.data;
    assert.equal(done.answer, 'Answer based on the sources [1]. Also a made-up claim.');
    assert.equal(done.citations.length, 1);
    assert.equal(done.citations[0].n, 1);
    assert.equal(done.rejectedCitations, 1, 'the fabricated citation was caught');
    assert.ok(done.citations[0].pageStart >= 1);
  });

  test('the conversation stores both messages, and a query log is written', async () => {
    const { cookies, me, conv } = await setup();
    await ask(cookies, conv.id, 'How many layers does the encoder have?');

    const detail = (await app.inject({ method: 'GET', url: `/conversations/${conv.id}`, cookies })).json();
    assert.equal(detail.conversation.title, 'How many layers does the encoder have?');
    assert.deepEqual(detail.messages.map((m: { role: string }) => m.role), ['user', 'assistant']);
    assert.equal(detail.messages[1].citations.length, 1);
    // The trace is stored with the answer, so "Why this answer?" survives a reload.
    assert.ok(detail.messages[1].trace.chunks.length > 0);
    assert.equal(detail.messages[1].trace.rejectedCitations, 1);
    assert.equal(detail.messages[0].trace, null);

    const log = (await pool.query('SELECT citations_rejected, provider, total_ms FROM query_logs WHERE user_id = $1', [me.id])).rows[0];
    assert.equal(log.citations_rejected, 1);
    assert.equal(log.provider, 'fake');
    assert.ok(log.total_ms >= 0);
  });

  test('follow-up questions are rewritten into standalone questions before retrieval', async () => {
    const { cookies, conv } = await setup();
    await ask(cookies, conv.id, 'How many layers does the encoder have?');
    const res = await ask(cookies, conv.id, 'And the decoder?');

    const sources = parseSse(res.body).find((e) => e.event === 'sources')!.data;
    assert.equal(sources.searchQuery, 'How many layers does the decoder have?');
    const answerCall = llm.requests.findLast((r) => r.tier === 'main')!;
    assert.ok(answerCall.messages.length > 1, 'recent conversation turns are included');
    assert.ok(answerCall.messages.slice(0, -1).every((m) => !/\[\d+\]/.test(m.text)), 'old citation markers stripped');
  });

  test('with nothing relevant to search, it says so without calling the LLM', async () => {
    const cookies = await signUp(app); // no documents at all
    const conv = (await app.inject({ method: 'POST', url: '/conversations', cookies })).json().conversation;
    const before = llm.requests.length;

    const done = parseSse((await ask(cookies, conv.id, 'What is the capital of France?')).body).at(-1)!.data;
    assert.equal(done.notFound, true);
    assert.match(done.answer, /couldn't find/);
    assert.equal(llm.requests.length, before, 'no LLM call was made');
  });

  test("you cannot ask in, read or delete someone else's conversation", async () => {
    const { conv } = await setup();
    const stranger = await signUp(app);
    assert.equal((await ask(stranger, conv.id, 'Show me their data')).statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: `/conversations/${conv.id}`, cookies: stranger })).statusCode, 404);
    assert.equal((await app.inject({ method: 'DELETE', url: `/conversations/${conv.id}`, cookies: stranger })).statusCode, 404);
  });

  test('a repeated first question is served from the cache with no LLM call', async () => {
    const { cookies } = await setup();
    const newConv = async () => (await app.inject({ method: 'POST', url: '/conversations', cookies })).json().conversation.id;
    const first = parseSse((await ask(cookies, await newConv(), 'How many layers does the encoder have?')).body).at(-1)!.data;
    const calls = llm.requests.length;
    const second = parseSse((await ask(cookies, await newConv(), '  how many layers does the ENCODER have  ')).body).at(-1)!.data;

    assert.equal(first.cacheHit, false);
    assert.equal(second.cacheHit, true, 'normalized question hits the cache');
    assert.equal(second.answer, first.answer);
    assert.equal(llm.requests.length, calls, 'no LLM call for a cache hit');
  });

  test('uploading a new document changes the cache key, so stale answers are never served', async () => {
    const { cookies, me } = await setup();
    const newConv = async () => (await app.inject({ method: 'POST', url: '/conversations', cookies })).json().conversation.id;
    await ask(cookies, await newConv(), 'What optimizer was used?');
    await seedDocument(pool, me.id, 'Another paper', ['A different optimizer called Lion was used here.']);
    const after = parseSse((await ask(cookies, await newConv(), 'What optimizer was used?')).body).at(-1)!.data;
    assert.equal(after.cacheHit, false);
  });

  test('follow-up questions are never served from the cache', async () => {
    const { cookies, conv } = await setup();
    await ask(cookies, conv.id, 'How many layers does the encoder have?');
    await ask(cookies, conv.id, 'And the decoder?');
    const again = parseSse((await ask(cookies, conv.id, 'And the decoder?')).body).at(-1)!.data;
    assert.equal(again.cacheHit, false);
  });

  test('per-user rate limit and daily token budget return 429 before any streaming', async () => {
    const strict = await buildApp(testConfig({ ASK_RATE_LIMIT_PER_MIN: 2, DAILY_TOKEN_BUDGET: 5_000 }), { db: pool, embedder: new FakeEmbedder(), llm });
    const cookies = await signUp(strict);
    const me = (await strict.inject({ method: 'GET', url: '/me', cookies })).json().user;
    const conv = (await strict.inject({ method: 'POST', url: '/conversations', cookies })).json().conversation;
    const askStrict = (q: string) => strict.inject({ method: 'POST', url: `/conversations/${conv.id}/ask`, cookies, payload: { question: q } });

    await askStrict('first question here');
    await askStrict('second question here');
    const limited = await askStrict('third question here');
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.json().error, 'rate_limited');

    await pool.query(`UPDATE query_logs SET created_at = now() - interval '2 minutes' WHERE user_id = $1`, [me.id]);
    await pool.query(`INSERT INTO query_logs (user_id, input_tokens, output_tokens) VALUES ($1, 4000, 2000)`, [me.id]);
    const overBudget = await askStrict('fourth question here');
    assert.equal(overBudget.statusCode, 429);
    assert.equal(overBudget.json().error, 'budget_exceeded');

    const metrics = (await strict.inject({ method: 'GET', url: '/metrics/summary', cookies })).json();
    assert.equal(metrics.questions7d, 3);
    assert.ok(metrics.tokensToday >= 6000);
    assert.equal(metrics.dailyTokenBudget, 5_000);
    await strict.close();
  });

  test('invalid questions are rejected before any streaming starts', async () => {
    const { cookies, conv } = await setup();
    const res = await ask(cookies, conv.id, ' ');
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, 'validation_error');
  });
});
