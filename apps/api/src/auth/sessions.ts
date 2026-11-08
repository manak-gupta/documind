import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '../db/pool.ts';

export const SESSION_COOKIE = 'dm_session';
export const SESSION_TTL_DAYS = 30;

export interface AuthUser {
  id: string;
  email: string;
}

// The browser holds the raw token; the database holds only its SHA-256.
// If the sessions table ever leaks, the hashes can't be replayed as cookies.
// (A fast hash is fine here: the token is 256 random bits, so there's nothing to brute-force.)
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export async function createSession(db: Db, userId: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await db.query(
    `INSERT INTO sessions (id, user_id, expires_at)
     VALUES ($1, $2, now() + make_interval(days => $3))`,
    [hashToken(token), userId, SESSION_TTL_DAYS],
  );
  return token;
}

export async function findUserBySession(db: Db, token: string): Promise<AuthUser | null> {
  const { rows } = await db.query<AuthUser>(
    `SELECT u.id, u.email
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.id = $1 AND s.expires_at > now()`,
    [hashToken(token)],
  );
  return rows[0] ?? null;
}

export async function deleteSession(db: Db, token: string): Promise<void> {
  await db.query('DELETE FROM sessions WHERE id = $1', [hashToken(token)]);
}
