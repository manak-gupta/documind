import pg from 'pg';
import { createPool } from '../db/pool.ts';
import { runMigrations } from '../db/migrate.ts';

// Integration tests run against a separate database (documind_test) on the same Postgres,
// so they never touch dev data. In CI, TEST_DATABASE_URL points at a service container.
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://documind:documind@localhost:5432/documind_test';

export async function createTestDb(): Promise<pg.Pool> {
  // Create the test database if it doesn't exist (connect to the default "postgres" DB to do it).
  const url = new URL(TEST_DATABASE_URL);
  const dbName = url.pathname.slice(1);
  url.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: url.toString() });
  await admin.connect();
  try {
    const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (!rowCount) {
      // Test files run in parallel; if another one created it first, that's fine (42P04).
      await admin.query(`CREATE DATABASE "${dbName}"`).catch((err) => {
        if (err.code !== '42P04') throw err;
      });
    }
  } finally {
    await admin.end();
  }

  const pool = createPool(TEST_DATABASE_URL);
  await runMigrations(pool); // advisory lock makes this safe across parallel test files
  return pool;
}

// Unique per call, so parallel tests never collide and no table truncation is needed.
export const uniqueEmail = () => `user-${crypto.randomUUID()}@test.dev`;
