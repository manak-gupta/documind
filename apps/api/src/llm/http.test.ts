import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, fetchJsonWithRetry } from './http.ts';

// A fake fetch that replays a script of responses and records the waits.
function scripted(responses: (Response | Error)[]) {
  const calls: number[] = [];
  const sleeps: number[] = [];
  const fetchImpl = (async () => {
    calls.push(1);
    const next = responses.shift();
    if (!next) throw new Error('script exhausted');
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { fetchImpl, sleep: async (ms: number) => void sleeps.push(ms), calls, sleeps, onRetry: () => {} };
}

test('gives up immediately when the server asks for an unreasonably long wait (daily quota)', async () => {
  const s = scripted([json(429, { error: { details: [{ retryDelay: '3600s' }] } })]);
  await assert.rejects(fetchJsonWithRetry('http://x', {}, s), /retry in 3601 s; giving up/);
  assert.deepEqual(s.sleeps, [], 'did not sleep for an hour');
});

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

test('retries 429 and 503 with growing delays, then succeeds', async () => {
  const s = scripted([json(429, {}), json(503, {}), json(200, { ok: true })]);
  const result = await fetchJsonWithRetry<{ ok: boolean }>('http://x', {}, { ...s, baseDelayMs: 100 });
  assert.deepEqual(result, { ok: true });
  assert.equal(s.calls.length, 3);
  assert.ok(s.sleeps[1]! > s.sleeps[0]!, 'exponential backoff');
});

test('honours Retry-After when the server sends it', async () => {
  const s = scripted([json(429, {}, { 'retry-after': '7' }), json(200, {})]);
  await fetchJsonWithRetry('http://x', {}, s);
  assert.deepEqual(s.sleeps, [7_000]);
});

test('does not retry a 400 or a bad key: retrying cannot fix them', async () => {
  const s = scripted([json(400, { error: 'bad request' })]);
  await assert.rejects(fetchJsonWithRetry('http://x', {}, s), (err: ApiError) => err.status === 400);
  assert.equal(s.calls.length, 1);
});

test('retries network errors and gives up after the retry budget', async () => {
  const s = scripted(Array.from({ length: 5 }, () => new Error('ECONNRESET')));
  await assert.rejects(fetchJsonWithRetry('http://x', {}, { ...s, retries: 4 }), /ECONNRESET/);
  assert.equal(s.calls.length, 5);
});
