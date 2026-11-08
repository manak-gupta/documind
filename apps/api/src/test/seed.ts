import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { FakeEmbedder, toPgVector } from '../llm/embedder.ts';

const embedder = new FakeEmbedder();

// Inserts a ready document with the given chunk texts (one chunk per string, page = index + 1),
// skipping PDF parsing. Lets retrieval tests control exactly what's in the index.
export async function seedDocument(
  pool: pg.Pool,
  userId: string,
  title: string,
  chunks: string[],
): Promise<string> {
  const documentId = randomUUID();
  await pool.query(
    `INSERT INTO documents (id, user_id, title, filename, sha256, size_bytes, storage_key, status, page_count)
     VALUES ($1, $2, $3, $4, $5, 1, 'seed', 'ready', $6)`,
    [documentId, userId, title, `${title}.pdf`, randomUUID(), chunks.length],
  );
  const vectors = await embedder.embedDocuments(chunks);
  for (const [i, content] of chunks.entries()) {
    await pool.query(
      `INSERT INTO chunks (document_id, user_id, ordinal, page_start, page_end, content, token_count, embedding)
       VALUES ($1, $2, $3, $4, $4, $5, $6, $7::vector)`,
      [documentId, userId, i, i + 1, content, Math.ceil(content.length / 4), toPgVector(vectors[i]!)],
    );
  }
  return documentId;
}
