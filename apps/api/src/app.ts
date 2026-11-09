import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { metricsRoutes } from './metrics/routes.ts';
import type { Config } from './config.ts';
import type { Db } from './db/pool.ts';
import { registerErrorHandler } from './http/errors.ts';
import { registerAuth } from './auth/routes.ts';
import { documentRoutes } from './documents/routes.ts';
import { type DocumentEvents, noEvents } from './documents/events.ts';
import type { Embedder } from './llm/embedder.ts';
import { createEmbedder, createLlm } from './llm/factory.ts';
import type { LlmProvider } from './llm/provider.ts';
import { chatRoutes } from './chat/routes.ts';
import { searchRoutes } from './retrieval/routes.ts';

// Everything the app needs from the outside world is passed in here ("dependency injection").
// Production passes a real Postgres pool; tests pass a fake or a test database.
export interface Deps {
  db: Db;
  events?: DocumentEvents; // live ingestion updates; optional so simple tests can skip it
  embedder?: Embedder;     // defaults to the one LLM_PROVIDER selects
  llm?: LlmProvider;       // likewise
}

// buildApp creates the server WITHOUT starting it.
// Tests call app.inject() against this object: real routing, no network port.
export async function buildApp(config: Config, deps: Deps) {
  const app = Fastify({
    logger: config.NODE_ENV === 'test' ? false : { level: config.LOG_LEVEL },
    // Lets every log line from one request be found by the same id.
    requestIdHeader: 'x-request-id',
  });

  registerErrorHandler(app);
  // Security headers on every response (nosniff, frame-ancestors, referrer policy, ...).
  await app.register(helmet);
  // Rate limiting is opt-in per route (see the auth routes): global: false.
  await app.register(rateLimit, { global: false });
  await app.register(cookie);
  await app.register(multipart);
  await registerAuth(app, { config, db: deps.db });
  // Registered as an encapsulated plugin on purpose: its requireAuth hook applies to its routes only.
  await app.register(documentRoutes, { config, db: deps.db, events: deps.events ?? noEvents });
  const embedder = deps.embedder ?? createEmbedder(config);
  await app.register(searchRoutes, { db: deps.db, embedder, keywordWeight: config.RRF_KEYWORD_WEIGHT });
  const limits = { askRatePerMin: config.ASK_RATE_LIMIT_PER_MIN, dailyTokenBudget: config.DAILY_TOKEN_BUDGET };
  await app.register(chatRoutes, {
    db: deps.db, embedder, llm: deps.llm ?? createLlm(config), abstainSimilarity: config.ABSTAIN_SIMILARITY, limits,
    keywordWeight: config.RRF_KEYWORD_WEIGHT,
  });
  await app.register(metricsRoutes, { db: deps.db, limits });

  // Health check for Docker / the load balancer.
  // 503 tells them "this instance can't serve traffic right now" (here: DB unreachable).
  app.get('/health', async (_req, reply) => {
    const started = performance.now();
    try {
      await deps.db.query('SELECT 1');
      return {
        status: 'ok',
        db: 'ok',
        dbLatencyMs: Math.round(performance.now() - started),
        uptimeSeconds: Math.round(process.uptime()),
      };
    } catch (err) {
      app.log.error({ err }, 'health check: database unreachable');
      return reply.code(503).send({ status: 'degraded', db: 'unreachable' });
    }
  });

  return app;
}
