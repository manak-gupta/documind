import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

// Node 26 ships argon2 natively, so we don't need a native npm package.
const argon2Async = promisify(argon2);

// OWASP-recommended argon2id settings: 19 MiB memory, 2 passes, 1 lane.
// Memory-hard means GPUs can't cheaply try billions of guesses against a leaked hash.
const PARAMS = { memory: 19_456, passes: 2, parallelism: 1, tagLength: 32 } as const;

// Stored format (PHC-style, self-describing):
//   argon2id$m=19456,t=2,p=1$<salt base64>$<hash base64>
// The parameters live inside the string, so raising them later doesn't break old hashes.
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16); // unique per password: identical passwords get different hashes
  const hash = await argon2Async('argon2id', { message: password, nonce: salt, ...PARAMS });
  const { memory: m, passes: t, parallelism: p } = PARAMS;
  return `argon2id$m=${m},t=${t},p=${p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, paramStr, saltB64, hashB64] = stored.split('$');
  if (algo !== 'argon2id' || !paramStr || !saltB64 || !hashB64) return false;

  const params = Object.fromEntries(paramStr.split(',').map((kv) => kv.split('=')));
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await argon2Async('argon2id', {
    message: password,
    nonce: Buffer.from(saltB64, 'base64'),
    memory: Number(params.m),
    passes: Number(params.t),
    parallelism: Number(params.p),
    tagLength: expected.length,
  });

  // Constant-time compare: a normal === stops at the first different byte,
  // and that timing difference can leak information.
  return timingSafeEqual(actual, expected);
}
