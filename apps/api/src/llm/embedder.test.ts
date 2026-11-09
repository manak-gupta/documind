import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeEmbedder, GeminiEmbedder, toPgVector } from './embedder.ts';

const cosine = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0);

test('fake embedder: texts sharing words are closer than unrelated texts', async () => {
  const e = new FakeEmbedder();
  const [revenue, costs] = await e.embedDocuments(['quarterly revenue grew in asia', 'office costs were flat']);
  const q = await e.embedQuery('how did revenue grow in asia');
  assert.ok(cosine(q, revenue!) > cosine(q, costs!));
  assert.equal(q.length, 768);
});

test('gemini embedder batches 250 texts into 3 requests with the right task type', async () => {
  const bodies: { requests: { taskType: string; outputDimensionality: number }[] }[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    bodies.push(body);
    return new Response(JSON.stringify({
      embeddings: body.requests.map(() => ({ values: new Array(8).fill(0.1) })),
    }));
  }) as typeof fetch;

  const e = new GeminiEmbedder({ apiKey: 'k', model: 'm', dimensions: 8, requestsPerMinute: 1000, retry: { fetchImpl } });
  const vectors = await e.embedDocuments(Array.from({ length: 250 }, (_, i) => `text ${i}`));

  assert.equal(vectors.length, 250);
  assert.deepEqual(bodies.map((b) => b.requests.length), [100, 100, 50]);
  assert.equal(bodies[0]!.requests[0]!.taskType, 'RETRIEVAL_DOCUMENT');
  assert.equal(bodies[0]!.requests[0]!.outputDimensionality, 8);

  await e.embedQuery('q');
  assert.equal(bodies.at(-1)!.requests[0]!.taskType, 'RETRIEVAL_QUERY');
});

test('gemini embedder rejects vectors of the wrong size instead of storing garbage', async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ embeddings: [{ values: [1, 2, 3] }] }))) as unknown as typeof fetch;
  const e = new GeminiEmbedder({ apiKey: 'k', model: 'm', dimensions: 768, retry: { fetchImpl } });
  await assert.rejects(e.embedQuery('q'), /Expected 768 dimensions, got 3/);
});

test('pgvector text format', () => {
  assert.equal(toPgVector([0.5, -1, 2]), '[0.5,-1,2]');
});
