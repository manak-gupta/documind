import type pg from 'pg';
import { type Job, claimJob, completeJob, failJob, recoverStaleJobs } from './queue.ts';

export type JobHandler = (job: Job) => Promise<void>;

export interface WorkerLogger {
  info(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface WorkerOptions {
  pollIntervalMs?: number; // fallback polling; NOTIFY normally wakes us instantly
  log?: WorkerLogger;
}

// The worker loop:
//   1. claim a due job → run its handler → mark done, or failed-with-retry
//   2. if there's no job, sleep until either a NOTIFY arrives or the poll interval passes
// One job at a time per worker process. To scale, run more worker processes:
// SKIP LOCKED guarantees they never take the same job.
export async function startWorker(
  pool: pg.Pool,
  handlers: Record<string, JobHandler>,
  { pollIntervalMs = 5_000, log = consoleLogger }: WorkerOptions = {},
) {
  const types = Object.keys(handlers);
  let stopping = false;
  let wake: (() => void) | null = null;

  // A dedicated connection that stays open to receive NOTIFY messages (the trigger in 002).
  const listener = await pool.connect();
  listener.on('notification', () => wake?.());
  listener.on('error', (err) => log.error({ err: err.message }, 'job listener error; falling back to polling'));
  await listener.query('LISTEN jobs');

  const recovered = await recoverStaleJobs(pool);
  if (recovered) log.info({ recovered }, 'requeued stale jobs');

  const sleep = () =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, pollIntervalMs);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    }).finally(() => {
      wake = null;
    });

  const loop = (async () => {
    while (!stopping) {
      let job: Job | null = null;
      try {
        job = await claimJob(pool, types);
      } catch (err) {
        log.error({ err: (err as Error).message }, 'could not claim job (database down?)');
      }

      if (!job) {
        await sleep();
        continue;
      }

      const started = performance.now();
      try {
        await handlers[job.type]!(job);
        await completeJob(pool, job.id);
        log.info({ jobId: job.id, type: job.type, ms: Math.round(performance.now() - started) }, 'job done');
      } catch (err) {
        const { willRetry } = await failJob(pool, job, err);
        log.error(
          { jobId: job.id, type: job.type, attempt: job.attempts, willRetry, err: (err as Error).message },
          'job failed',
        );
      }
    }
  })();

  return {
    // Graceful stop: lets the current job finish, then exits the loop.
    async stop() {
      stopping = true;
      wake?.();
      await loop;
      await listener.query('UNLISTEN jobs').catch(() => {});
      listener.release();
    },
  };
}

const consoleLogger: WorkerLogger = {
  info: (obj, msg) => console.log(JSON.stringify({ level: 'info', msg, ...obj })),
  error: (obj, msg) => console.error(JSON.stringify({ level: 'error', msg, ...obj })),
};
