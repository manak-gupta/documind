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

  test('invalid questions are rejected before any streaming starts', async () => {
    const { cookies, conv } = await setup();
    const res = await ask(cookies, conv.id, ' ');
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, 'validation_error');
  });
});
