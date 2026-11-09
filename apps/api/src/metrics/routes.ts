import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/pool.ts';
import { requireAuth } from '../auth/routes.ts';
import type { Limits } from '../chat/limits.ts';

// The signed-in user's own usage and performance, computed from query_logs.
// percentile_cont gives true p50/p95 latencies (averages hide slow outliers).
export async function metricsRoutes(app: FastifyInstance, opts: { db: Db; limits: Limits }) {
  app.addHook('preHandler', requireAuth);

  app.get('/metrics/summary', async (req) => {
    const { rows } = await opts.db.query(
      `SELECT count(*)::int                                                            AS "questions7d",
              count(*) FILTER (WHERE created_at >= date_trunc('day', now()))::int       AS "questionsToday",
              coalesce(sum(input_tokens + output_tokens)
                FILTER (WHERE created_at >= date_trunc('day', now())), 0)::int          AS "tokensToday",
              round(avg(cache_hit::int) * 100)::int                                     AS "cacheHitPct",
              percentile_cont(0.5) WITHIN GROUP (ORDER BY ttft_ms)
                FILTER (WHERE ttft_ms IS NOT NULL)::int                                 AS "ttftP50",
              percentile_cont(0.95) WITHIN GROUP (ORDER BY ttft_ms)
                FILTER (WHERE ttft_ms IS NOT NULL)::int                                 AS "ttftP95",
              percentile_cont(0.5) WITHIN GROUP (ORDER BY total_ms)
                FILTER (WHERE NOT cache_hit)::int                                       AS "totalP50",
              percentile_cont(0.5) WITHIN GROUP (ORDER BY retrieval_ms)
                FILTER (WHERE NOT cache_hit)::int                                       AS "retrievalP50",
              coalesce(sum(citations_rejected), 0)::int                                 AS "citationsRejected"
         FROM query_logs
        WHERE user_id = $1 AND created_at > now() - interval '7 days'`,
      [req.user!.id],
    );
    return { ...rows[0], dailyTokenBudget: opts.limits.dailyTokenBudget };
  });
}
