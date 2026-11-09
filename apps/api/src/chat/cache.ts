import { createHash } from 'node:crypto';
import type { Db } from '../db/pool.ts';

// Exact-match answer cache.
//
// Why not a "semantic" cache (reuse the answer to a SIMILAR question)? Because similar isn't
// the same: "revenue in 2022" and "revenue in 2023" embed almost identically, and a semantic
// cache would confidently serve the wrong year. An exact key never serves a wrong answer.
//
// The key includes a "corpus version" (the ids and upload times of the documents in scope),
// so uploading or deleting a document changes the key: stale answers are never served and
// there's nothing to invalidate by hand.

const TTL_DAYS = 7;

const normalizeQuestion = (q: string) => q.toLowerCase().replace(/\s+/g, ' ').replace(/[?.!\s]+$/, '').trim();

export async function cacheKey(db: Db, userId: string, question: string, documentIds?: string[]): Promise<string> {
  const { rows } = await db.query<{ corpus: string | null }>(
    `SELECT string_agg(id::text || '@' || extract(epoch FROM created_at)::text, ',' ORDER BY id) AS corpus
       FROM documents
      WHERE user_id = $1 AND status = 'ready' AND ($2::uuid[] IS NULL OR id = ANY($2::uuid[]))`,
    [userId, documentIds?.length ? documentIds : null],
  );
  return createHash('sha256')
    .update(JSON.stringify([userId, normalizeQuestion(question), rows[0]?.corpus ?? '']))
    .digest('hex');
}

export async function getCached<T>(db: Db, key: string): Promise<T | null> {
  const { rows } = await db.query<{ response: T }>(
    `SELECT response FROM answer_cache WHERE key = $1 AND created_at > now() - make_interval(days => $2)`,
    [key, TTL_DAYS],
  );
  return rows[0]?.response ?? null;
}

export async function setCached(db: Db, key: string, response: unknown): Promise<void> {
  await db.query(
    `INSERT INTO answer_cache (key, response) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET response = EXCLUDED.response, created_at = now()`,
    [key, JSON.stringify(response)],
  );
  // Opportunistic cleanup instead of a cron job: cheap with the primary-key index.
  await db.query(`DELETE FROM answer_cache WHERE created_at < now() - make_interval(days => $1)`, [TTL_DAYS]);
}
