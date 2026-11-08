import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp, type Deps } from './app.ts';

const testConfig = {
  NODE_ENV: 'test',
  PORT: 0,
  LOG_LEVEL: 'fatal',
  WEB_ORIGIN: 'http://localhost:5173',
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
} as const;

// Fake databases: just enough of the Db type for /health.
const healthyDb = { query: async () => ({ rows: [{ '?column?': 1 }] }) } as unknown as Deps['db'];
const brokenDb = {
  query: async () => {
    throw new Error('connection refused');
  },
} as unknown as Deps['db'];

test('GET /health returns 200 when the database answers', async () => {
  const app = buildApp(testConfig, { db: healthyDb });
  const res = await app.inject({ method: 'GET', url: '/health' });

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, 'ok');
  assert.equal(res.json().db, 'ok');
  await app.close();
});

test('GET /health returns 503 when the database is down', async () => {
  const app = buildApp(testConfig, { db: brokenDb });
  const res = await app.inject({ method: 'GET', url: '/health' });

  assert.equal(res.statusCode, 503);
  assert.equal(res.json().db, 'unreachable');
  await app.close();
});
