import { loadConfig } from './config.ts';
import { buildApp } from './app.ts';

const config = loadConfig();
const app = buildApp(config);

// Docker stops containers with SIGTERM; Ctrl+C sends SIGINT.
// app.close() stops accepting new connections and lets in-flight requests finish.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    process.exit(0);
  });
}

// 0.0.0.0, not localhost: inside a container, localhost is unreachable from outside.
await app.listen({ port: config.PORT, host: '0.0.0.0' });
