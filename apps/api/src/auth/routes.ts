import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.ts';
import type { Db } from '../db/pool.ts';
import { HttpError } from '../http/errors.ts';
import { hashPassword, verifyPassword } from './password.ts';
import {
  type AuthUser,
  SESSION_COOKIE,
  SESSION_TTL_DAYS,
  createSession,
  deleteSession,
  findUserBySession,
} from './sessions.ts';

// Make `request.user` a typed property on every request.
declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser | null;
  }
}

const Credentials = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  // The max length stops someone from making us hash a 10 MB "password".
  password: z.string().min(8, 'Password must be at least 8 characters').max(128),
});

// Route guard: add `{ preHandler: requireAuth }` to any route that needs a logged-in user.
export async function requireAuth(req: FastifyRequest) {
  if (!req.user) throw new HttpError(401, 'unauthorized', 'Please log in');
}

// Called directly on the ROOT app (not via app.register): app.register() creates an
// encapsulated child context, and the onRequest hook below would then only run for the
// routes in this file. We want req.user set for every route in the app.
export async function registerAuth(app: FastifyInstance, opts: { config: Config; db: Db }) {
  const { config, db } = opts;

  const cookieOptions = {
    path: '/',
    httpOnly: true,                              // JavaScript can't read it, so XSS can't steal it
    secure: config.NODE_ENV === 'production',    // HTTPS-only in production
    sameSite: 'lax' as const,                    // not sent on cross-site POSTs: blocks CSRF
    maxAge: SESSION_TTL_DAYS * 24 * 60 * 60,     // seconds
  };

  const startSession = async (reply: FastifyReply, userId: string) => {
    const token = await createSession(db, userId);
    reply.setCookie(SESSION_COOKIE, token, cookieOptions);
  };

  // A real hash of a random password, computed once. When an email doesn't exist we still
  // verify against it, so "unknown email" and "wrong password" take the same time.
  // Otherwise response timing would reveal which emails have accounts.
  const dummyHash = await hashPassword(randomUUID());

  // Runs before every route in this app: turns the cookie into req.user (or null).
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (req) => {
    const token = req.cookies[SESSION_COOKIE];
    req.user = token ? await findUserBySession(db, token) : null;
  });

  app.post('/auth/register', async (req, reply) => {
    const { email, password } = Credentials.parse(req.body);
    const passwordHash = await hashPassword(password);

    // ON CONFLICT DO NOTHING + check rowCount: race-safe, unlike "SELECT then INSERT".
    const { rows } = await db.query<AuthUser>(
      `INSERT INTO users (email, password_hash) VALUES ($1, $2)
       ON CONFLICT (email) DO NOTHING
       RETURNING id, email`,
      [email, passwordHash],
    );
    const user = rows[0];
    if (!user) throw new HttpError(409, 'email_taken', 'An account with this email already exists');

    await startSession(reply, user.id);
    return reply.code(201).send({ user });
  });

  app.post('/auth/login', async (req, reply) => {
    const { email, password } = Credentials.parse(req.body);
    const { rows } = await db.query<AuthUser & { password_hash: string }>(
      'SELECT id, email, password_hash FROM users WHERE email = $1',
      [email],
    );
    const found = rows[0];
    const ok = await verifyPassword(password, found?.password_hash ?? dummyHash);

    // Same status and message for both cases: never reveal whether the email exists.
    if (!found || !ok) throw new HttpError(401, 'invalid_credentials', 'Email or password is incorrect');

    await startSession(reply, found.id);
    return { user: { id: found.id, email: found.email } };
  });

  app.post('/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await deleteSession(db, token); // server-side revoke, not just clearing the cookie
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.code(204).send();
  });

  app.get('/me', { preHandler: requireAuth }, async (req) => ({ user: req.user }));
}
