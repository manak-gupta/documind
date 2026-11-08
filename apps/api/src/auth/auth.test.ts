// Integration tests: real Fastify app + real Postgres (documind_test). Needs `npm run db:up`.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { buildApp } from '../app.ts';
import { createTestDb, uniqueEmail } from '../test/db.ts';
import { testConfig } from '../test/config.ts';
import { SESSION_COOKIE } from './sessions.ts';

describe('auth', () => {
  let pool: pg.Pool;
  let app: Awaited<ReturnType<typeof buildApp>>;

  before(async () => {
    pool = await createTestDb();
    app = await buildApp(testConfig(), { db: pool });
  });
  after(async () => {
    await app.close();
    await pool.end();
  });

  const register = (email: string, password = 'password123') =>
    app.inject({ method: 'POST', url: '/auth/register', payload: { email, password } });
  type InjectCookie = { name: string; value: string; httpOnly?: boolean; sameSite?: string };
  const sessionFrom = (res: { cookies: InjectCookie[] }) =>
    res.cookies.find((c) => c.name === SESSION_COOKIE);

  test('register creates a user, sets a secure session cookie, and /me works', async () => {
    const email = uniqueEmail();
    const res = await register(email);
    assert.equal(res.statusCode, 201);

    const cookie = sessionFrom(res as never);
    assert.ok(cookie, 'session cookie is set');
    assert.equal(cookie.httpOnly, true);
    assert.equal(cookie.sameSite, 'Lax');

    const me = await app.inject({ method: 'GET', url: '/me', cookies: { [SESSION_COOKIE]: cookie.value } });
    assert.equal(me.statusCode, 200);
    assert.equal(me.json().user.email, email);
  });

  test('the database stores a hash of the session token, never the token itself', async () => {
    const cookie = sessionFrom((await register(uniqueEmail())) as never)!;
    const raw = await pool.query('SELECT 1 FROM sessions WHERE id = $1', [cookie.value]);
    assert.equal(raw.rowCount, 0);
  });

  test('email is unique regardless of case', async () => {
    const email = uniqueEmail();
    assert.equal((await register(email)).statusCode, 201);
    const dup = await register(email.toUpperCase());
    assert.equal(dup.statusCode, 409);
    assert.equal(dup.json().error, 'email_taken');
  });

  test('wrong password and unknown email give the identical response', async () => {
    const email = uniqueEmail();
    await register(email, 'right-password');

    const wrongPw = await app.inject({
      method: 'POST', url: '/auth/login', payload: { email, password: 'wrong-password' },
    });
    const unknown = await app.inject({
      method: 'POST', url: '/auth/login', payload: { email: uniqueEmail(), password: 'wrong-password' },
    });
    assert.equal(wrongPw.statusCode, 401);
    assert.equal(unknown.statusCode, 401);
    assert.deepEqual(wrongPw.json(), unknown.json());
  });

  test('login with correct credentials starts a new session', async () => {
    const email = uniqueEmail();
    await register(email, 'right-password');
    const res = await app.inject({
      method: 'POST', url: '/auth/login', payload: { email: `  ${email.toUpperCase()} `, password: 'right-password' },
    });
    assert.equal(res.statusCode, 200);
    assert.ok(sessionFrom(res as never));
  });

  test('logout revokes the session on the server', async () => {
    const token = sessionFrom((await register(uniqueEmail())) as never)!.value;
    const cookies = { [SESSION_COOKIE]: token };

    assert.equal((await app.inject({ method: 'POST', url: '/auth/logout', cookies })).statusCode, 204);
    // Replaying the old cookie must fail: it was deleted server-side, not just cleared in the browser.
    assert.equal((await app.inject({ method: 'GET', url: '/me', cookies })).statusCode, 401);
  });

  test('invalid input is rejected with field-level errors', async () => {
    const res = await register('not-an-email', 'short');
    assert.equal(res.statusCode, 400);
    const paths = res.json().issues.map((i: { path: string }) => i.path).sort();
    assert.deepEqual(paths, ['email', 'password']);
  });

  test('/me without a cookie is 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/me' });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().error, 'unauthorized');
  });
});
