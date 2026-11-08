import type { Db } from '../db/pool.ts';

export interface Job {
  id: number;
  type: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

// Atomically take the oldest due job of the given types and mark it running.
//
// FOR UPDATE      locks the chosen row until this statement's transaction ends.
// SKIP LOCKED     makes other workers skip rows that are already locked instead of waiting,
//                 so N workers grab N different jobs in parallel and never the same one.
// The UPDATE ... WHERE id = (subquery) runs as one statement, so "pick" and "mark running"
// can't be interleaved by another worker.
export async function claimJob(db: Db, types: string[]): Promise<Job | null> {
  const { rows } = await db.query<Job>(
    `UPDATE jobs
        SET status = 'running', locked_at = now(), attempts = attempts + 1
      WHERE id = (
        SELECT id FROM jobs
         WHERE status = 'queued' AND run_after <= now() AND type = ANY($1)
         ORDER BY run_after
         FOR UPDATE SKIP LOCKED
         LIMIT 1
      )
      RETURNING id, type, payload, attempts, max_attempts`,
    [types],
  );
  return rows[0] ?? null;
}

export async function completeJob(db: Db, jobId: number): Promise<void> {
  await db.query(`UPDATE jobs SET status = 'done', locked_at = NULL WHERE id = $1`, [jobId]);
}

// Throw this from a handler when retrying can't help (e.g. a scanned PDF has no text).
export class PermanentJobError extends Error {}

// Retry with exponential backoff (10 s, 20 s, 40 s, ...) until max_attempts, then give up.
// Backoff matters for rate-limited APIs: retrying instantly just hits the same limit again.
export async function failJob(db: Db, job: Job, error: unknown): Promise<{ willRetry: boolean }> {
  const message = error instanceof Error ? error.message : String(error);
  const willRetry = !(error instanceof PermanentJobError) && job.attempts < job.max_attempts;
  await db.query(
    `UPDATE jobs
        SET status = $2,
            locked_at = NULL,
            last_error = $3,
            run_after = now() + make_interval(secs => $4)
      WHERE id = $1`,
    [job.id, willRetry ? 'queued' : 'failed', message.slice(0, 2000), 10 * 2 ** (job.attempts - 1)],
  );
  return { willRetry };
}

// If a worker crashes mid-job, its job stays "running" forever. On startup we put jobs
// that have been running suspiciously long back in the queue.
export async function recoverStaleJobs(db: Db, olderThanMinutes = 15): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE jobs SET status = 'queued', locked_at = NULL
      WHERE status = 'running' AND locked_at < now() - make_interval(mins => $1)`,
    [olderThanMinutes],
  );
  return rowCount ?? 0;
}
