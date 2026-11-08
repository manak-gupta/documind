import Fastify from 'fastify';
import type { Config } from './config.ts';

// buildApp creates the server WITHOUT starting it.
// Tests call app.inject() against this object: real routing, no network port.
export function buildApp(config: Config) {
  const app = Fastify({
    logger: config.NODE_ENV === 'test' ? false : { level: config.LOG_LEVEL },
    // Lets every log line from one request be found by the same id.
    requestIdHeader: 'x-request-id',
  });

  // Liveness check for Docker / the load balancer. A database check is added in step 3.
  app.get('/health', async () => ({
    status: 'ok',
    uptimeSeconds: Math.round(process.uptime()),
  }));

  return app;
}
