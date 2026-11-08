import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from './app.ts';

const testConfig = {
  NODE_ENV: 'test',
  PORT: 0,
  LOG_LEVEL: 'fatal',
  WEB_ORIGIN: 'http://localhost:5173',
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
} as const;

test('GET /health returns ok', async () => {
  const app = buildApp(testConfig);
  const res = await app.inject({ method: 'GET', url: '/health' });

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, 'ok');
  await app.close();
});
