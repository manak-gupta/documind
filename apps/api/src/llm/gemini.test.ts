import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GeminiLlm, readSse } from './gemini.ts';

// Captures request bodies and replies with a tiny SSE stream.
function fakeGemini() {
  const bodies: { generationConfig: Record<string, unknown> }[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(init.body as string));
    const sse = 'data: {"candidates":[{"content":{"parts":[{"text":"Hel"}]}}]}\n\n' +
      'data: {"candidates":[{"content":{"parts":[{"text":"lo","thought":false},{"text":"(hidden)","thought":true}]}}],' +
      '"usageMetadata":{"promptTokenCount":12,"candidatesTokenCount":2,"thoughtsTokenCount":5}}\n\n';
    return new Response(sse);
  }) as unknown as typeof fetch;
  return { bodies, fetchImpl };
}

const llm = (thinking: 'off' | 'low', fetchImpl: typeof fetch) =>
  new GeminiLlm({ apiKey: 'k', model: 'main-model', fastModel: 'lite-model', thinking, retry: { fetchImpl } });

test('streams visible text, hides thought parts, and counts thinking tokens as output', async () => {
  const { fetchImpl } = fakeGemini();
  const { text, usage, model } = await llm('low', fetchImpl).complete({ system: 's', messages: [{ role: 'user', text: 'q' }] });
  assert.equal(text, 'Hello');
  assert.deepEqual(usage, { inputTokens: 12, outputTokens: 7 });
  assert.equal(model, 'main-model');
});

test('regression: the fast tier sends NO thinking config (flash-lite rejects thinkingBudget: 0)', async () => {
  const { bodies, fetchImpl } = fakeGemini();
  await llm('off', fetchImpl).complete({ system: 's', tier: 'fast', messages: [{ role: 'user', text: 'q' }] });
  assert.equal(bodies[0]!.generationConfig.thinkingConfig, undefined);
});

test('main tier maps thinking off -> budget 0, and low -> thinkingLevel', async () => {
  const off = fakeGemini();
  await llm('off', off.fetchImpl).complete({ system: 's', messages: [{ role: 'user', text: 'q' }] });
  assert.deepEqual(off.bodies[0]!.generationConfig.thinkingConfig, { thinkingBudget: 0 });

  const low = fakeGemini();
  await llm('low', low.fetchImpl).complete({ system: 's', messages: [{ role: 'user', text: 'q' }] });
  assert.deepEqual(low.bodies[0]!.generationConfig.thinkingConfig, { thinkingLevel: 'low' });
});

test('the SSE reader reassembles events split at arbitrary byte boundaries', async () => {
  const text = 'data: {"a":1}\n\ndata: {"a":2}\r\n\r\n';
  const bytes = new TextEncoder().encode(text);
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < bytes.length; i += 3) c.enqueue(bytes.slice(i, i + 3)); // 3-byte pieces
      c.close();
    },
  });
  const events = [];
  for await (const e of readSse<{ a: number }>(stream)) events.push(e.a);
  assert.deepEqual(events, [1, 2]);
});
