// Worker process entry point: `npm run worker`.
// Runs ingestion jobs so CPU-heavy PDF parsing never slows down the API's request handling.
import { loadConfig } from './config.ts';
import { createPool } from './db/pool.ts';
import { ingestDocument } from './ingestion/pipeline.ts';
import { startWorker } from './jobs/runner.ts';
import { createEmbedder } from './llm/factory.ts';

const config = loadConfig();
const pool = createPool(config.DATABASE_URL);
const embedder = createEmbedder(config);

// Fail fast if the configured embedding size doesn't match the vector(N) column.
// Otherwise every insert would fail at runtime, document after document.
const { rows } = await pool.query<{ dims: number }>(
  `SELECT atttypmod AS dims FROM pg_attribute
    WHERE attrelid = 'chunks'::regclass AND attname = 'embedding'`);
if (rows[0]?.dims !== embedder.dimensions) {
  console.error(`EMBEDDING_DIM=${embedder.dimensions} but chunks.embedding is vector(${rows[0]?.dims}). ` +
    'Run a migration to change the column (and re-embed), or fix the config.');
  process.exit(1);
}

const worker = await startWorker(pool, {
  ingest: (job) =>
    ingestDocument(
      { pool, embedder, uploadDir: config.UPLOAD_DIR },
      job.payload.documentId as string,
      { isLastAttempt: job.attempts >= job.max_attempts },
    ),
});
console.log(JSON.stringify({ level: 'info', msg: 'worker started', embedder: embedder.model }));

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    console.log(JSON.stringify({ level: 'info', msg: 'worker stopping; finishing current job', signal }));
    await worker.stop();
    await pool.end();
    process.exit(0);
  });
}
