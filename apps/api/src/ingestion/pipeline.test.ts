// End-to-end ingestion: upload through the API -> pipeline -> chunks in Postgres -> SSE event.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { buildApp } from '../app.ts';
import { DocumentEventHub } from '../documents/events.ts';
import { PermanentJobError } from '../jobs/queue.ts';
import { FakeEmbedder, type Embedder } from '../llm/embedder.ts';
import { createTestDb } from '../test/db.ts';
import { testConfig } from '../test/config.ts';
import { multipartFile, signUp } from '../test/http.ts';
import { makePdf } from '../test/pdf.ts';
import { ingestDocument } from './pipeline.ts';

describe('ingestion pipeline', () => {
  const config = testConfig();
  let pool: pg.Pool;
  let events: DocumentEventHub;
  let app: Awaited<ReturnType<typeof buildApp>>;

  before(async () => {
    pool = await createTestDb();
    events = await DocumentEventHub.start(pool);
    app = await buildApp(config, { db: pool, events });
  });
  after(async () => {
    await app.close();
    await events.close();
    await pool.end();
  });

  const uploadPdf = async (cookies: Record<string, string>, pdf: Buffer, name = 'report.pdf') =>
    (await app.inject({ method: 'POST', url: '/documents', cookies, ...multipartFile(name, pdf) })).json().document;

  const reportPdf = () =>
    makePdf(
      [
        [
          { text: 'Results', size: 18 },
          ...Array.from({ length: 30 }, (_, i) => ({ text: `Revenue in region ${i} grew by ${i}% during the year ${Date.now()}.` })),
        ],
        [
          { text: 'Outlook', size: 18 },
          ...Array.from({ length: 6 }, (_, i) => ({ text: `Management expects steady growth in market ${i} next year.` })),
        ],
      ],
      'Acme Annual Report',
    );

  const deps = (embedder: Embedder = new FakeEmbedder()) => ({ pool, embedder, uploadDir: config.UPLOAD_DIR });

  test('a text PDF becomes ready with page-tagged, embedded chunks', async () => {
    const cookies = await signUp(app);
    const doc = await uploadPdf(cookies, reportPdf());

    await ingestDocument(deps(), doc.id, { isLastAttempt: false });

    const { rows: [d] } = await pool.query('SELECT status, progress, page_count, title FROM documents WHERE id = $1', [doc.id]);
    assert.deepEqual(d, { status: 'ready', progress: 100, page_count: 2, title: 'Acme Annual Report' });

    const { rows: chunks } = await pool.query(
      `SELECT heading, page_start, page_end, vector_dims(embedding) AS dims FROM chunks
        WHERE document_id = $1 ORDER BY ordinal`, [doc.id]);
    assert.ok(chunks.length >= 2);
    assert.equal(chunks[0].heading, 'Results');
    assert.equal(chunks.at(-1).heading, 'Outlook');
    assert.equal(chunks.at(-1).page_start, 2);
    assert.ok(chunks.every((c) => c.dims === 768));
  });

  test('re-running ingestion (a retry) replaces chunks instead of duplicating them', async () => {
    const cookies = await signUp(app);
    const doc = await uploadPdf(cookies, reportPdf());
    await ingestDocument(deps(), doc.id, { isLastAttempt: false });
    const count = async () => (await pool.query('SELECT count(*)::int AS n FROM chunks WHERE document_id = $1', [doc.id])).rows[0].n;
    const first = await count();
    await ingestDocument(deps(), doc.id, { isLastAttempt: false });
    assert.equal(await count(), first);
  });

  test('a scanned PDF fails permanently with a helpful message (no pointless retries)', async () => {
    const cookies = await signUp(app);
    const doc = await uploadPdf(cookies, makePdf([[], []]), 'scan.pdf');

    await assert.rejects(ingestDocument(deps(), doc.id, { isLastAttempt: false }), PermanentJobError);
    const { rows: [d] } = await pool.query('SELECT status, error FROM documents WHERE id = $1', [doc.id]);
    assert.equal(d.status, 'failed');
    assert.match(d.error, /scanned/i);
  });

  test('a transient failure leaves the document queued for retry; the last attempt marks it failed', async () => {
    const cookies = await signUp(app);
    const doc = await uploadPdf(cookies, reportPdf());
    const flaky: Embedder = { model: 'flaky', dimensions: 768, embedQuery: async () => [], embedDocuments: async () => { throw new Error('HTTP 503'); } };

    await assert.rejects(ingestDocument(deps(flaky), doc.id, { isLastAttempt: false }));
    let row = (await pool.query('SELECT status, stage FROM documents WHERE id = $1', [doc.id])).rows[0];
    assert.deepEqual(row, { status: 'queued', stage: 'retrying' });

    await assert.rejects(ingestDocument(deps(flaky), doc.id, { isLastAttempt: true }));
    row = (await pool.query('SELECT status, error FROM documents WHERE id = $1', [doc.id])).rows[0];
    assert.equal(row.status, 'failed');
    assert.doesNotMatch(row.error, /503/, 'internal error details are not shown to the user');
  });

  test('progress is streamed to the owner over SSE, and only to the owner', async () => {
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const owner = await signUp(app);
    const stranger = await signUp(app);
    const doc = await uploadPdf(owner, reportPdf());

    const collect = async (cookies: Record<string, string>) => {
      const cookie = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
      const controller = new AbortController();
      const res = await fetch(`${address}/documents/events`, { headers: { cookie }, signal: controller.signal });
      const reader = res.body!.getReader();
      let text = '';
      const reading = (async () => {
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            text += new TextDecoder().decode(value);
          }
        } catch { /* aborted */ }
      })();
      return { stop: async () => { controller.abort(); await reading; return text; }, contentType: res.headers.get('content-type') };
    };

    const ownerStream = await collect(owner);
    const strangerStream = await collect(stranger);
    await new Promise((r) => setTimeout(r, 100));

    await ingestDocument(deps(), doc.id, { isLastAttempt: false });
    await new Promise((r) => setTimeout(r, 300));

    const ownerText = await ownerStream.stop();
    const strangerText = await strangerStream.stop();

    assert.equal(ownerStream.contentType, 'text/event-stream; charset=utf-8');
    const stages = [...ownerText.matchAll(/data: (.+)/g)].map((m) => JSON.parse(m[1]!));
    assert.deepEqual([...new Set(stages.map((e) => e.status))], ['processing', 'ready']);
    assert.ok(stages.every((e) => e.documentId === doc.id && !('userId' in e)));
    assert.equal(stages.at(-1).progress, 100);
    assert.doesNotMatch(strangerText, /data:/, "other users never see this document's events");
  });
});
