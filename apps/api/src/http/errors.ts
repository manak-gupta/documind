import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

// Throw this from any route for an expected failure, e.g. new HttpError(409, 'email_taken').
export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message?: string) {
    super(message ?? code);
    this.statusCode = statusCode;
    this.code = code;
  }
}

// One place decides how every error looks to the client: { error, message, issues? }.
// Unexpected errors are logged in full but returned as a generic 500, so internals
// (SQL, stack traces) never reach the browser.
export function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof z.ZodError) {
      return reply.code(400).send({
        error: 'validation_error',
        message: 'Invalid request',
        issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send({ error: err.code, message: err.message });
    }
    // Fastify's own 4xx errors (malformed JSON, body too large, rate limited, ...).
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 429) {
      return reply.code(429).send({ error: 'rate_limited', message: 'Too many attempts. Please wait a minute and try again.' });
    }
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({ error: 'bad_request', message: (err as Error).message });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: 'internal_error', message: 'Something went wrong' });
  });
}
