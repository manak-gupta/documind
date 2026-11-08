import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { SESSION_COOKIE } from '../auth/sessions.ts';
import { uniqueEmail } from './db.ts';

// Registers a fresh user and returns the cookies object to send with later requests.
export async function signUp(app: FastifyInstance): Promise<Record<string, string>> {
  const res = await app.inject({
    method: 'POST', url: '/auth/register', payload: { email: uniqueEmail(), password: 'password123' },
  });
  const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE);
  if (!cookie) throw new Error(`sign-up failed: ${res.statusCode} ${res.body}`);
  return { [SESSION_COOKIE]: cookie.value };
}

// Builds a multipart/form-data body by hand (what a browser sends for <input type="file">).
export function multipartFile(filename: string, content: Buffer, field = 'file') {
  const boundary = `----documind${randomBytes(8).toString('hex')}`;
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\n` +
      'Content-Type: application/pdf\r\n\r\n'),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload: body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

// Unique bytes per call, so each "PDF" gets its own sha256 unless a test reuses it on purpose.
export const fakePdf = () => Buffer.from(`%PDF-1.4\n% test ${randomBytes(8).toString('hex')}\n%%EOF\n`);
