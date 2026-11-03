import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';

/**
 * Password hashing for accounts: scrypt from `node:crypto`, no dependency.
 * The stored form names its own parameters (`scrypt$N$r$p$salt$hash`), so
 * raising them later re-hashes on the next sign-in instead of locking anyone
 * out.
 */

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

/** OWASP's scrypt recommendation: N=2^17, r=8, p=1 (128 MiB per hash). */
export const DEFAULT_SCRYPT_PARAMS: ScryptParams = { N: 2 ** 17, r: 8, p: 1 };

const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
/** Each hash holds 128·N·r bytes; two at once keeps a small container clear of its limit. */
const MAX_CONCURRENT_HASHES = 2;

let running = 0;
const waiting: Array<() => void> = [];

async function withHashSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT_HASHES) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

function derive(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  const maxmem = 128 * params.N * params.r * params.p + 32 * 1024 * 1024;
  return withHashSlot(
    () =>
      new Promise<Buffer>((resolve, reject) => {
        scryptCallback(
          password.normalize('NFKC'),
          salt,
          KEY_LENGTH,
          { N: params.N, r: params.r, p: params.p, maxmem },
          (err, key) => (err ? reject(err) : resolve(key)),
        );
      }),
  );
}

export async function hashPassword(
  password: string,
  params: ScryptParams = DEFAULT_SCRYPT_PARAMS,
): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = await derive(password, salt, params);
  return [
    'scrypt',
    params.N,
    params.r,
    params.p,
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$');
}

interface ParsedHash {
  params: ScryptParams;
  salt: Buffer;
  key: Buffer;
}

function parseHash(encoded: string): ParsedHash | null {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [N = 0, r = 0, p = 0] = parts.slice(1, 4).map((n) => Number(n));
  if (![N, r, p].every((n) => Number.isInteger(n) && n > 0)) return null;
  // Refuse parameters that would let a tampered file exhaust memory.
  if (N > 2 ** 20 || r > 32 || p > 16) return null;
  const salt = Buffer.from(parts[4] ?? '', 'base64url');
  const key = Buffer.from(parts[5] ?? '', 'base64url');
  if (salt.length < 8 || key.length !== KEY_LENGTH) return null;
  return { params: { N, r, p }, salt, key };
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parsed = parseHash(encoded);
  if (!parsed) return false;
  const key = await derive(password, parsed.salt, parsed.params);
  return timingSafeEqual(key, parsed.key);
}

/** True when the stored hash used weaker parameters than `params`. */
export function needsRehash(
  encoded: string,
  params: ScryptParams = DEFAULT_SCRYPT_PARAMS,
): boolean {
  const parsed = parseHash(encoded);
  if (!parsed) return true;
  return parsed.params.N < params.N || parsed.params.r < params.r || parsed.params.p < params.p;
}

/**
 * A hash of a password nobody has, for a sign-in that names no account: it
 * costs the same as a real check, so the response time does not say whether
 * the name exists.
 */
const dummyHashes = new Map<string, Promise<string>>();
export function dummyPasswordHash(params: ScryptParams = DEFAULT_SCRYPT_PARAMS): Promise<string> {
  const key = `${params.N}:${params.r}:${params.p}`;
  let hash = dummyHashes.get(key);
  if (!hash) {
    hash = hashPassword(randomBytes(18).toString('base64url'), params);
    dummyHashes.set(key, hash);
  }
  return hash;
}
