import type { Db } from '../db/pool.ts';
import { HttpError } from '../http/errors.ts';

export interface Limits {
  askRatePerMin: number;
  dailyTokenBudget: number;
}

// Per-user guards, enforced before any AI call:
//   - rate: at most N questions per rolling minute
//   - budget: at most N LLM tokens per UTC day
// Both are computed from query_logs in Postgres rather than in-process counters, so they stay
// correct across restarts and across several API instances behind a load balancer.
export async function enforceLimits(db: Db, userId: string, limits: Limits): Promise<void> {
  const { rows } = await db.query<{ last_minute: number; tokens_today: number }>(
    `SELECT count(*) FILTER (WHERE created_at > now() - interval '1 minute')::int AS last_minute,
            coalesce(sum(input_tokens + output_tokens) FILTER (WHERE created_at >= date_trunc('day', now())), 0)::int AS tokens_today
       FROM query_logs
      WHERE user_id = $1 AND created_at >= least(now() - interval '1 minute', date_trunc('day', now()))`,
    [userId],
  );
  const usage = rows[0]!;
  if (usage.last_minute >= limits.askRatePerMin) {
    throw new HttpError(429, 'rate_limited', `You can ask up to ${limits.askRatePerMin} questions per minute. Please wait a moment.`);
  }
  if (usage.tokens_today >= limits.dailyTokenBudget) {
    throw new HttpError(429, 'budget_exceeded', 'You have reached today’s usage limit. It resets at midnight UTC.');
  }
}
