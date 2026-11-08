// Integration tests: real app + real Postgres (documind_test). Needs `npm run db:up`.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type pg from 'pg';
import { buildApp } from '../app.ts';
import { createTestDb } from '../test/db.ts';
import { testConfig } from '../test/config.ts';
import { fakePdf, multipartFile, signUp } from '../test/http.ts';

describe('documents', () => {
  const config = testConfig({ MAX_UPLOAD_MB: 1, MAX_DOCS_PER_USER: 3 });
  let pool: pg.Pool;
  let app: Awaited<ReturnType<typeof buildApp>>;

  before(async () => {
    pool = await createTestDb();
    app = await buildApp(config, { db: pool });
  });
  after(async () => {
    await app.close();
    await pool.end();
  });

  const upload = (cookies: Record<string, string>, name: string, bytes: Buffer) =>
    app.inject({ method: 'POST', url: '/documents', cookies, ...multipartFile(name, bytes) });

  test('upload stores the file, creates the document and queues an ingest job', async () => {
    const cookies = await signUp(app);
    const res = await upload(cookies, 'Quarterly_Report-2024.pdf', fakePdf());

    assert.equal(res.statusCode, 202);
    const doc = res.json().document;
    assert.equal(doc.title, 'Quarterly Report 2024');
    assert.equal(doc.status, 'queued');

    const job = await pool.query(`SELECT type FROM jobs WHERE payload->>'documentId' = $1`, [doc.id]);
    assert.equal(job.rows[0]?.type, 'ingest');

    const { rows } = await pool.query('SELECT storage_key FROM documents WHERE id = $1', [doc.id]);
    assert.ok(existsSync(join(config.UPLOAD_DIR, rows[0].storage_key)));
  });

  test('uploading the same file twice returns the existing document and no new job', async () => {
    const cookies = await signUp(app);
    const pdf = fakePdf();
    const first = await upload(cookies, 'a.pdf', pdf);
    const second = await upload(cookies, 'renamed.pdf', pdf);

    assert.equal(second.statusCode, 200);
    assert.equal(second.json().duplicate, true);
    assert.equal(second.json().document.id, first.json().document.id);
    const jobs = await pool.query(`SELECT 1 FROM jobs WHERE payload->>'documentId' = $1`, [first.json().document.id]);
    assert.equal(jobs.rowCount, 1);
  });

  test('a file renamed to .pdf but not a PDF is rejected by its bytes', async () => {
    const cookies = await signUp(app);
    const res = await upload(cookies, 'evil.pdf', Buffer.from('MZ\x90\x00 this is an exe'));
    assert.equal(res.statusCode, 415);
    assert.equal(res.json().error, 'not_a_pdf');
  });

  test('files over the size limit are rejected', async () => {
    const cookies = await signUp(app);
    const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(1024 * 1024 + 10, 'a')]);
    const res = await upload(cookies, 'big.pdf', big);
    assert.equal(res.statusCode, 413);
  });

  test('the per-user document limit is enforced', async () => {
    const cookies = await signUp(app);
    for (let i = 0; i < 3; i++) assert.equal((await upload(cookies, `d${i}.pdf`, fakePdf())).statusCode, 202);
    const res = await upload(cookies, 'one-too-many.pdf', fakePdf());
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error, 'document_limit');
  });

  test('users only ever see their own documents', async () => {
    const alice = await signUp(app);
    const bob = await signUp(app);
    const doc = (await upload(alice, 'private.pdf', fakePdf())).json().document;

    const bobList = await app.inject({ method: 'GET', url: '/documents', cookies: bob });
    assert.deepEqual(bobList.json().documents, []);

    // 404 (not 403) for someone else's document: don't even confirm it exists.
    for (const req of [
      { method: 'GET' as const, url: `/documents/${doc.id}/file` },
      { method: 'DELETE' as const, url: `/documents/${doc.id}` },
    ]) {
      assert.equal((await app.inject({ ...req, cookies: bob })).statusCode, 404);
    }
    const file = await app.inject({ method: 'GET', url: `/documents/${doc.id}/file`, cookies: alice });
    assert.equal(file.statusCode, 200);
    assert.equal(file.headers['content-type'], 'application/pdf');
  });

  test('delete removes the document, its file and (by cascade) its chunks', async () => {
    const cookies = await signUp(app);
    const doc = (await upload(cookies, 'x.pdf', fakePdf())).json().document;
    const { rows } = await pool.query('SELECT storage_key FROM documents WHERE id = $1', [doc.id]);

    const res = await app.inject({ method: 'DELETE', url: `/documents/${doc.id}`, cookies });
    assert.equal(res.statusCode, 204);
    assert.equal(existsSync(join(config.UPLOAD_DIR, rows[0].storage_key)), false);
    assert.equal((await pool.query('SELECT 1 FROM documents WHERE id = $1', [doc.id])).rowCount, 0);
  });

  test('document routes require login, and a malformed id is a 400 not a 500', async () => {
    assert.equal((await app.inject({ method: 'GET', url: '/documents' })).statusCode, 401);
    const cookies = await signUp(app);
    assert.equal((await app.inject({ method: 'GET', url: '/documents/not-a-uuid/file', cookies })).statusCode, 400);
  });
});
