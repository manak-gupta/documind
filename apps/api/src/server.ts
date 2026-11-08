import { loadConfig } from './config.ts';
import { buildApp } from './app.ts';
import { createPool } from './db/pool.ts';

const config = loadConfig();
const pool = createPool(config.DATABASE_URL);
const app = buildApp(config, { db: pool });

// Docker stops containers with SIGTERM; Ctrl+C sends SIGINT.
// Order matters: stop taking requests and finish in-flight ones first, then close DB connections.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await pool.end();
    process.exit(0);
  });
}

// 0.0.0.0, not localhost: inside a container, localhost is unreachable from outside.
await app.listen({ port: config.PORT, host: '0.0.0.0' });
