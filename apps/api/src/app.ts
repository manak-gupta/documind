import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import type { Config } from './config.ts';
import type { Db } from './db/pool.ts';
import { registerErrorHandler } from './http/errors.ts';
import { registerAuth } from './auth/routes.ts';

// Everything the app needs from the outside world is passed in here ("dependency injection").
// Production passes a real Postgres pool; tests pass a fake or a test database.
export interface Deps {
  db: Db;
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
  await app.register(cookie);
  await registerAuth(app, { config, db: deps.db });

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
