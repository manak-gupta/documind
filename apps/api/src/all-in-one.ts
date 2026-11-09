// Migrations + API + ingestion worker in ONE process.
//
//   npm run demo            no API key needed: offline fake AI provider, own "documind_demo" DB
//   (end-to-end tests)      started by Playwright with its own database and port
//
// Production runs the API and worker as separate processes (see docker-compose.prod.yml); this
// entry point exists so the full app can be tried or tested with a single command.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.argv.includes('--demo')) {
  // Demo defaults (anything already set in the environment wins).
  process.env.LLM_PROVIDER ??= 'fake';
  process.env.ABSTAIN_SIMILARITY ??= '0.05'; // the offline embedder's similarities are low
  process.env.DATABASE_URL ??= 'postgres://documind:documind@localhost:5432/documind_demo';
  process.env.WEB_ORIGIN ??= 'http://localhost:5173';
  process.env.UPLOAD_DIR ??= mkdtempSync(join(tmpdir(), 'documind-demo-'));
}

const { loadConfig } = await import('./config.ts');
const { buildApp } = await import('./app.ts');
const { createPool } = await import('./db/pool.ts');
const { createDatabaseIfMissing } = await import('./db/create.ts');
const { runMigrations } = await import('./db/migrate.ts');
const { DocumentEventHub } = await import('./documents/events.ts');
const { ingestDocument } = await import('./ingestion/pipeline.ts');
const { startWorker } = await import('./jobs/runner.ts');
const { createEmbedder, createLlm } = await import('./llm/factory.ts');

const config = loadConfig();
await createDatabaseIfMissing(config.DATABASE_URL);
const pool = createPool(config.DATABASE_URL);
await runMigrations(pool);

const embedder = createEmbedder(config);
const events = await DocumentEventHub.start(pool);
const app = await buildApp(config, { db: pool, events, embedder, llm: createLlm(config) });
const worker = await startWorker(pool, {
  ingest: (job) => ingestDocument(
    { pool, embedder, uploadDir: config.UPLOAD_DIR },
    job.payload.documentId as string,
    { isLastAttempt: job.attempts >= job.max_attempts },
  ),
}, { pollIntervalMs: 1_000 });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await app.close();
    await worker.stop();
    await events.close();
    await pool.end();
    process.exit(0);
  });
}

await app.listen({ port: config.PORT, host: '0.0.0.0' });
console.log(`DocuMind (${config.LLM_PROVIDER} provider) on http://localhost:${config.PORT}`);
