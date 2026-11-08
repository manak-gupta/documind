import { readFile } from 'node:fs/promises';
import type pg from 'pg';
import type { Db } from '../db/pool.ts';
import { PermanentJobError } from '../jobs/queue.ts';
import { type Embedder, toPgVector } from '../llm/embedder.ts';
import { filePath } from '../storage/files.ts';
import { chunkPages, embeddingText } from './chunk.ts';
import { parsePdf } from './parse.ts';

export interface IngestDeps {
  pool: pg.Pool;
  embedder: Embedder;
  uploadDir: string;
}

const EMBED_BATCH = 50; // small enough to report progress often, big enough to be efficient

// Turns an uploaded PDF into searchable chunks. Runs in the worker process, never the API.
//
// Idempotent: a retry after a crash deletes any chunks from the failed attempt before
// inserting, so a document never ends up with duplicate chunks.
export async function ingestDocument(
  deps: IngestDeps,
  documentId: string,
  { isLastAttempt }: { isLastAttempt: boolean },
): Promise<void> {
  const { pool, embedder, uploadDir } = deps;
  const { rows } = await pool.query<{ user_id: string; title: string; storage_key: string }>(
    'SELECT user_id, title, storage_key FROM documents WHERE id = $1', [documentId]);
  const doc = rows[0];
  if (!doc) return; // deleted while queued: nothing to do

  try {
    await setStatus(pool, documentId, { status: 'processing', stage: 'parsing', progress: 5 });

    const bytes = await readFile(filePath(uploadDir, doc.storage_key));
    const parsed = await parsePdf(new Uint8Array(bytes)).catch((err: Error) => {
      throw new PermanentJobError(`Could not read this PDF (${err.message})`);
    });

    const chunks = chunkPages(parsed.pages);
    if (!chunks.length) {
      throw new PermanentJobError(parsed.scannedPages.length
        ? 'This PDF contains only scanned images, with no text layer. Scanned PDFs are not supported yet.'
        : 'No text was found in this PDF.');
    }

    // A real title from the PDF's metadata beats one guessed from the file name.
    const title = parsed.title && parsed.title.length >= 3 && parsed.title.length <= 200 ? parsed.title : doc.title;

    await setStatus(pool, documentId, { status: 'processing', stage: 'embedding', progress: 15 });
    const vectors: number[][] = [];
    for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
      const batch = chunks.slice(i, i + EMBED_BATCH);
      vectors.push(...(await embedder.embedDocuments(batch.map((c) => embeddingText(c, title)))));
      const done = Math.min(i + EMBED_BATCH, chunks.length);
      await setStatus(pool, documentId, {
        status: 'processing', stage: 'embedding', progress: 15 + Math.round((80 * done) / chunks.length),
      });
    }

    // Save everything in ONE transaction: readers see either no chunks or all of them,
    // never a half-indexed document. The NOTIFY inside it is only delivered on COMMIT.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM chunks WHERE document_id = $1', [documentId]);
      // unnest() turns parallel arrays into rows: every chunk in one round trip.
      await client.query(
        `INSERT INTO chunks (document_id, user_id, ordinal, page_start, page_end, heading, content, token_count, embedding)
         SELECT $1, $2, t.ordinal, t.page_start, t.page_end, t.heading, t.content, t.token_count, t.embedding::vector
           FROM unnest($3::int[], $4::int[], $5::int[], $6::text[], $7::text[], $8::int[], $9::text[])
             AS t(ordinal, page_start, page_end, heading, content, token_count, embedding)`,
        [
          documentId,
          doc.user_id,
          chunks.map((c) => c.ordinal),
          chunks.map((c) => c.pageStart),
          chunks.map((c) => c.pageEnd),
          chunks.map((c) => c.heading),
          chunks.map((c) => c.content),
          chunks.map((c) => c.tokenCount),
          vectors.map(toPgVector),
        ],
      );
      await client.query(
        'UPDATE documents SET title = $2, page_count = $3, scanned_pages = $4 WHERE id = $1',
        [documentId, title, parsed.pageCount, parsed.scannedPages.length],
      );
      await setStatus(client, documentId, { status: 'ready', stage: null, progress: 100 });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    const permanent = err instanceof PermanentJobError;
    if (permanent || isLastAttempt) {
      // Users see a helpful message; the technical detail stays in jobs.last_error.
      const message = permanent ? (err as Error).message : 'Processing failed after several attempts. Please try again later.';
      await setStatus(pool, documentId, { status: 'failed', stage: null, progress: 0, error: message });
    } else {
      await setStatus(pool, documentId, { status: 'queued', stage: 'retrying', progress: 0 });
    }
    throw err; // the job runner records the failure and schedules any retry
  }
}

interface StatusUpdate {
  status: 'queued' | 'processing' | 'ready' | 'failed';
  stage: string | null;
  progress: number;
  error?: string;
}

// Updates the row and broadcasts the change in one statement. The API process LISTENs on
// "document_status" and forwards each event to that user's browser over SSE.
async function setStatus(db: Db, documentId: string, u: StatusUpdate): Promise<void> {
  await db.query(
    `WITH updated AS (
       UPDATE documents SET status = $2, stage = $3, progress = $4, error = $5
        WHERE id = $1
        RETURNING id, user_id, status, stage, progress, error, page_count
     )
     SELECT pg_notify('document_status', json_build_object(
       'documentId', id, 'userId', user_id, 'status', status, 'stage', stage,
       'progress', progress, 'error', error, 'pageCount', page_count)::text)
     FROM updated`,
    [documentId, u.status, u.stage, u.progress, u.error ?? null],
  );
}
