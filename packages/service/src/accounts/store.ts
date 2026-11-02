import {
  readSecurityJson,
  writeSecurityJson,
} from '@bendyline/gezel-inference/internal/fs/security-json';

/**
 * On-disk shapes for accounts and their sessions. Both files sit beside
 * `tokens.json` but are separate from it on purpose: its loader refuses
 * durable first-party authority, so an older daemon reading a home written
 * by this one ignores these files instead of refusing to start.
 */

export interface StoredAccount {
  id: string;
  name: string;
  role: string;
  passwordHash: string;
  createdAt: string;
  updatedAt: string;
  passwordChangedAt?: string;
  lastSignInAt?: string;
  disabledAt?: string;
}

export interface StoredSession {
  id: string;
  accountId: string;
  /** sha256 of the bearer token, hex. The token itself is never stored. */
  tokenHash: string;
  createdAt: string;
  lastSeenAt: string;
  /** The absolute limit; sliding expiry is computed from `lastSeenAt`. */
  expiresAt: string;
  label?: string;
  address?: string;
}

const optionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value ? value : undefined;

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || !value) throw new Error(`missing ${key}`);
  return value;
}

export function decodeAccounts(raw: string): StoredAccount[] {
  const parsed = JSON.parse(raw) as { version?: unknown; accounts?: unknown };
  if (parsed?.version !== 1 || !Array.isArray(parsed.accounts)) {
    throw new Error('unsupported version or missing accounts array');
  }
  return parsed.accounts.map((entry) => {
    if (!entry || typeof entry !== 'object') throw new Error('invalid account record');
    const r = entry as Record<string, unknown>;
    return {
      id: requireString(r, 'id'),
      name: requireString(r, 'name'),
      // Kept even when unknown: a newer build's role must survive a
      // downgrade, and `isKnownAccountRole` stops it signing in here.
      role: requireString(r, 'role'),
      passwordHash: requireString(r, 'passwordHash'),
      createdAt: requireString(r, 'createdAt'),
      updatedAt: requireString(r, 'updatedAt'),
      passwordChangedAt: optionalString(r.passwordChangedAt),
      lastSignInAt: optionalString(r.lastSignInAt),
      disabledAt: optionalString(r.disabledAt),
    };
  });
}

export function decodeSessions(raw: string): StoredSession[] {
  const parsed = JSON.parse(raw) as { version?: unknown; sessions?: unknown };
  if (parsed?.version !== 1 || !Array.isArray(parsed.sessions)) {
    throw new Error('unsupported version or missing sessions array');
  }
  return parsed.sessions.map((entry) => {
    if (!entry || typeof entry !== 'object') throw new Error('invalid session record');
    const r = entry as Record<string, unknown>;
    return {
      id: requireString(r, 'id'),
      accountId: requireString(r, 'accountId'),
      tokenHash: requireString(r, 'tokenHash'),
      createdAt: requireString(r, 'createdAt'),
      lastSeenAt: requireString(r, 'lastSeenAt'),
      expiresAt: requireString(r, 'expiresAt'),
      label: optionalString(r.label),
      address: optionalString(r.address),
    };
  });
}

export async function readAccounts(filePath: string): Promise<StoredAccount[]> {
  return (await readSecurityJson(filePath, 'accounts', decodeAccounts)) ?? [];
}

export async function readSessions(filePath: string): Promise<StoredSession[]> {
  return (await readSecurityJson(filePath, 'account sessions', decodeSessions)) ?? [];
}

export async function writeAccounts(filePath: string, accounts: StoredAccount[]): Promise<void> {
  await writeSecurityJson(filePath, `${JSON.stringify({ version: 1, accounts }, null, 2)}\n`);
}

export async function writeSessions(filePath: string, sessions: StoredSession[]): Promise<void> {
  await writeSecurityJson(filePath, `${JSON.stringify({ version: 1, sessions }, null, 2)}\n`);
}
