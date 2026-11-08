import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from './password.ts';

test('a correct password verifies, a wrong one does not', async () => {
  const stored = await hashPassword('correct horse battery');
  assert.equal(await verifyPassword('correct horse battery', stored), true);
  assert.equal(await verifyPassword('correct horse batterY', stored), false);
});

test('the same password hashes differently each time (random salt)', async () => {
  const a = await hashPassword('same-password');
  const b = await hashPassword('same-password');
  assert.notEqual(a, b);
  assert.match(a, /^argon2id\$m=19456,t=2,p=1\$/);
});

test('a malformed stored hash is rejected, not thrown', async () => {
  assert.equal(await verifyPassword('anything', 'not-a-hash'), false);
});
