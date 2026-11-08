import { createReadStream } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.ts';
import type { Db } from '../db/pool.ts';
import { requireAuth } from '../auth/routes.ts';
import { HttpError } from '../http/errors.ts';
import { deleteFile, filePath, saveUpload } from '../storage/files.ts';
import type { DocumentEvents } from './events.ts';

const IdParams = z.object({ id: z.uuid() });

const DOC_COLUMNS = `id, title, filename, size_bytes AS "sizeBytes", page_count AS "pageCount",
  scanned_pages AS "scannedPages", status, stage, progress, error, created_at AS "createdAt"`;

// "Quarterly_Report-2024.pdf" -> "Quarterly Report 2024"
const titleFromFilename = (name: string) =>
  name.replace(/\.pdf$/i, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Untitled';

export async function documentRoutes(
  app: FastifyInstance,
  opts: { config: Config; db: Db; events: DocumentEvents },
) {
  const { config, db, events } = opts;
  const maxBytes = config.MAX_UPLOAD_MB * 1024 * 1024;

  app.addHook('preHandler', requireAuth); // every route in this file needs a logged-in user

  app.post('/documents', async (req, reply) => {
    const userId = req.user!.id;

    const { rows: countRows } = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM documents WHERE user_id = $1', [userId]);
    if (countRows[0]!.n >= config.MAX_DOCS_PER_USER) {
      throw new HttpError(403, 'document_limit', `You can store up to ${config.MAX_DOCS_PER_USER} documents`);
    }

    const part = await req.file({ limits: { fileSize: maxBytes, files: 1 } });
    if (!part) throw new HttpError(400, 'no_file', 'Attach a PDF in the "file" field');

    const saved = await saveUpload(part.file, config.UPLOAD_DIR);

    // At the size limit the multipart stream doesn't throw: it silently stops and sets
    // `truncated`. Without this check we'd store a chopped-off PDF.
    if (part.file.truncated) {
      await deleteFile(config.UPLOAD_DIR, saved.storageKey);
      throw new HttpError(413, 'file_too_large', `PDFs can be at most ${config.MAX_UPLOAD_MB} MB`);
    }

    // Never trust the file name or the browser's Content-Type: check the actual bytes.
    if (!saved.isPdf) {
      await deleteFile(config.UPLOAD_DIR, saved.storageKey);
      throw new HttpError(415, 'not_a_pdf', 'Only PDF files are supported');
    }

    // One statement = one transaction: the document row and its ingestion job are created
    // together or not at all. ON CONFLICT handles "same user uploads the same file again".
    const { rows } = await db.query<{ id: string }>(
      `WITH doc AS (
         INSERT INTO documents (user_id, title, filename, sha256, size_bytes, storage_key)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (user_id, sha256) DO NOTHING
         RETURNING id
       ), job AS (
         INSERT INTO jobs (type, payload)
         SELECT 'ingest', jsonb_build_object('documentId', id) FROM doc
       )
       SELECT id FROM doc`,
      [userId, titleFromFilename(part.filename), part.filename, saved.sha256, saved.sizeBytes, saved.storageKey],
    );

    if (!rows[0]) {
      // Duplicate: drop the new copy and point the client at the existing document.
      await deleteFile(config.UPLOAD_DIR, saved.storageKey);
      const existing = await db.query(
        `SELECT ${DOC_COLUMNS} FROM documents WHERE user_id = $1 AND sha256 = $2`, [userId, saved.sha256]);
      return reply.code(200).send({ document: existing.rows[0], duplicate: true });
    }

    const created = await db.query(`SELECT ${DOC_COLUMNS} FROM documents WHERE id = $1`, [rows[0].id]);
    // 202 Accepted: stored, but processing happens in the background.
    return reply.code(202).send({ document: created.rows[0], duplicate: false });
  });

  app.get('/documents', async (req) => {
    const { rows } = await db.query(
      `SELECT ${DOC_COLUMNS} FROM documents WHERE user_id = $1 ORDER BY created_at DESC`, [req.user!.id]);
    return { documents: rows };
  });

  // Live ingestion progress via Server-Sent Events: a long-lived HTTP response the server
  // keeps writing to. One-way (server -> browser) is all we need, and unlike WebSockets it's
  // plain HTTP, so it passes through proxies and Cloudflare, and browsers auto-reconnect.
  app.get('/documents/events', async (req, reply) => {
    reply.hijack(); // we write the raw response ourselves; Fastify must not end it
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no', // tell reverse proxies not to buffer the stream
    });
    res.write('retry: 3000\n\n'); // browser reconnect delay if the connection drops

    const unsubscribe = events.subscribe(req.user!.id, ({ userId: _omit, ...event }) => {
      res.write(`event: document\ndata: ${JSON.stringify(event)}\n\n`);
    });
    // Proxies (and Cloudflare, after 100 s) close connections that look idle.
    // A comment line every 15 s keeps it open and costs a few bytes.
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);

    req.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  app.get('/documents/:id/file', async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    // user_id in the WHERE clause is the access check. Another user's document gives 404,
    // not 403, so its existence isn't revealed.
    const { rows } = await db.query<{ storage_key: string; filename: string }>(
      'SELECT storage_key, filename FROM documents WHERE id = $1 AND user_id = $2', [id, req.user!.id]);
    const doc = rows[0];
    if (!doc) throw new HttpError(404, 'not_found', 'Document not found');

    return reply
      .type('application/pdf')
      .header('Content-Disposition', `inline; filename="${encodeURIComponent(doc.filename)}"`)
      .header('Cache-Control', 'private, max-age=3600')
      .send(createReadStream(filePath(config.UPLOAD_DIR, doc.storage_key)));
  });

  app.delete('/documents/:id', async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    // ON DELETE CASCADE removes the chunks and their vectors in the same statement.
    const { rows } = await db.query<{ storage_key: string }>(
      'DELETE FROM documents WHERE id = $1 AND user_id = $2 RETURNING storage_key', [id, req.user!.id]);
    if (!rows[0]) throw new HttpError(404, 'not_found', 'Document not found');

    await deleteFile(config.UPLOAD_DIR, rows[0].storage_key);
    return reply.code(204).send();
  });
}
