import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter } from './rate-limiter.ts';
import { serverDelayMs } from './http.ts';

// A fake clock: sleeping just advances time, so these tests run instantly.
function fakeClock() {
  let t = 0;
  const slept: number[] = [];
  return { now: () => t, sleep: async (ms: number) => { slept.push(ms); t += ms; }, slept, get t() { return t; } };
}

test('spends freely under the limit, then waits for the window to free up', async () => {
  const clock = fakeClock();
  const limiter = new RateLimiter({ max: 100, windowMs: 60_000, now: clock.now, sleep: clock.sleep });
  await limiter.acquire(60);
  await limiter.acquire(40);           // exactly at the limit: no wait
  assert.deepEqual(clock.slept, []);
  await limiter.acquire(10);           // over: must wait until the first spend leaves the window
  assert.ok(clock.t >= 60_000, `waited until t=${clock.t}`);
});

test('a batch bigger than the whole limit is an error, not an infinite wait', async () => {
  const limiter = new RateLimiter({ max: 90 });
  await assert.rejects(limiter.acquire(91), /limit is 90/);
});

test("reads Google's retryDelay from a 429 body, and the standard Retry-After header", () => {
  const body = '{"error":{"code":429,"details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"37s"}]}}';
  assert.equal(serverDelayMs(new Response('', { status: 429 }), body), 37_500);
  assert.equal(serverDelayMs(new Response('', { status: 429, headers: { 'retry-after': '5' } }), ''), 5_000);
  assert.equal(serverDelayMs(new Response('', { status: 503 }), 'overloaded'), null);
});
