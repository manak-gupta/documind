import type pg from 'pg';
import { createPool } from '../db/pool.ts';
import { createDatabaseIfMissing } from '../db/create.ts';
import { runMigrations } from '../db/migrate.ts';

// Integration tests run against a separate database (documind_test) on the same Postgres,
// so they never touch dev data. In CI, TEST_DATABASE_URL points at a service container.
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://documind:documind@localhost:5432/documind_test';

export async function createTestDb(): Promise<pg.Pool> {
  await createDatabaseIfMissing(TEST_DATABASE_URL);
  const pool = createPool(TEST_DATABASE_URL);
  await runMigrations(pool); // advisory lock makes this safe across parallel test files
  return pool;
}

// Unique per call, so parallel tests never collide and no table truncation is needed.
export const uniqueEmail = () => `user-${crypto.randomUUID()}@test.dev`;
