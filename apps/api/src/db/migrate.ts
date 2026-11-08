import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

// A minimal migration runner. Rules:
//  - Migrations are plain .sql files named 001_xxx.sql, 002_xxx.sql … applied in name order.
//  - Each one runs in its own transaction: it applies completely or not at all.
//  - Applied versions are recorded in schema_migrations, so re-running is a no-op.
//  - An advisory lock stops two processes (e.g. api + worker starting together) from
//    migrating at the same time.

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));
const LOCK_ID = 727_001; // any app-wide constant; identifies "the migration lock"

export async function runMigrations(pool: pg.Pool, dir = MIGRATIONS_DIR): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);

    const done = await client.query<{ version: string }>('SELECT version FROM schema_migrations');
    const doneSet = new Set(done.rows.map((r) => r.version));

    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      if (doneSet.has(version)) continue;

      const sql = await readFile(join(dir, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
        await client.query('COMMIT');
        applied.push(version);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
    client.release();
  }
}

// `npm run migrate` runs this file directly.
if (import.meta.main) {
  const { loadConfig } = await import('../config.ts');
  const { createPool } = await import('./pool.ts');
  const pool = createPool(loadConfig().DATABASE_URL);
  try {
    const applied = await runMigrations(pool);
    console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date.');
  } finally {
    await pool.end();
  }
}
