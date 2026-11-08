// Integration tests for the Postgres job queue. Each test uses its own job type, so tests
// running in parallel (and the documents tests' ingest jobs) never interfere.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { createTestDb } from '../test/db.ts';
import { claimJob, failJob, recoverStaleJobs } from './queue.ts';
import { startWorker } from './runner.ts';

const silent = { info() {}, error() {} };

describe('job queue', () => {
  let pool: pg.Pool;
  before(async () => {
    pool = await createTestDb();
  });
  after(async () => {
    await pool.end();
  });

  const newType = () => `test-${randomUUID()}`;
  const enqueue = async (type: string, n = 1, runAfter = 'now()') => {
    for (let i = 0; i < n; i++) {
      await pool.query(`INSERT INTO jobs (type, payload, run_after) VALUES ($1, $2, ${runAfter})`, [type, { i }]);
    }
  };
  const statusOf = async (id: number) =>
    (await pool.query('SELECT status, attempts, run_after > now() AS delayed FROM jobs WHERE id = $1', [id])).rows[0];

  test('a claimed job is marked running and cannot be claimed again', async () => {
    const type = newType();
    await enqueue(type);
    const job = await claimJob(pool, [type]);
    assert.ok(job);
    assert.equal(job.attempts, 1);
    assert.equal((await statusOf(job.id)).status, 'running');
    assert.equal(await claimJob(pool, [type]), null);
  });

  test('10 concurrent workers claiming 5 jobs get exactly 5 distinct jobs (SKIP LOCKED)', async () => {
    const type = newType();
    await enqueue(type, 5);
    const results = await Promise.all(Array.from({ length: 10 }, () => claimJob(pool, [type])));
    const claimed = results.filter((j) => j !== null).map((j) => j!.id);
    assert.equal(claimed.length, 5);
    assert.equal(new Set(claimed).size, 5, 'no job was handed to two workers');
  });

  test('jobs scheduled for the future are not claimed yet', async () => {
    const type = newType();
    await enqueue(type, 1, `now() + interval '1 hour'`);
    assert.equal(await claimJob(pool, [type]), null);
  });

  test('a failed job is retried with backoff, then marked failed after max attempts', async () => {
    const type = newType();
    await enqueue(type);
    const first = (await claimJob(pool, [type]))!;
    assert.deepEqual(await failJob(pool, first, new Error('boom')), { willRetry: true });
    const s = await statusOf(first.id);
    assert.equal(s.status, 'queued');
    assert.equal(s.delayed, true, 'retry is pushed into the future');

    // Make it due again and exhaust the remaining attempts.
    for (let attempt = 2; attempt <= 3; attempt++) {
      await pool.query('UPDATE jobs SET run_after = now() WHERE id = $1', [first.id]);
      const job = (await claimJob(pool, [type]))!;
      assert.equal(job.attempts, attempt);
      await failJob(pool, job, new Error('boom'));
    }
    assert.equal((await statusOf(first.id)).status, 'failed');
  });

  test('jobs stuck in "running" (crashed worker) are requeued', async () => {
    const type = newType();
    await enqueue(type);
    const job = (await claimJob(pool, [type]))!;
    await pool.query(`UPDATE jobs SET locked_at = now() - interval '1 hour' WHERE id = $1`, [job.id]);
    assert.ok((await recoverStaleJobs(pool, 15)) >= 1);
    assert.equal((await statusOf(job.id)).status, 'queued');
  });

  test('the worker is woken by NOTIFY, long before its poll interval', async () => {
    const type = newType();
    let resolveDone!: (ms: number) => void;
    const done = new Promise<number>((r) => (resolveDone = r));
    let queuedAt = 0;

    const worker = await startWorker(
      pool,
      { [type]: async () => resolveDone(performance.now() - queuedAt) },
      { pollIntervalMs: 60_000, log: silent },
    );
    await new Promise((r) => setTimeout(r, 100)); // let the worker reach its sleep
    queuedAt = performance.now();
    await enqueue(type);

    const latencyMs = await done;
    await worker.stop();
    assert.ok(latencyMs < 2_000, `picked up in ${Math.round(latencyMs)} ms (poll interval is 60 s)`);
  });

  test('a throwing handler marks the job for retry and the worker keeps running', async () => {
    const type = newType();
    let calls = 0;
    const worker = await startWorker(
      pool,
      { [type]: async () => { calls++; throw new Error('handler exploded'); } },
      { pollIntervalMs: 50, log: silent },
    );
    await enqueue(type);
    await new Promise((r) => setTimeout(r, 500));
    await worker.stop();

    assert.equal(calls, 1, 'retry waits for the backoff, not an instant loop');
    const { rows } = await pool.query('SELECT status, last_error FROM jobs WHERE type = $1', [type]);
    assert.equal(rows[0].status, 'queued');
    assert.equal(rows[0].last_error, 'handler exploded');
  });
});
