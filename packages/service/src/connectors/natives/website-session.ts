/**
 * A website binding's saved sign-in: the browser's cookies and local storage
 * for the site, after the person signed in once in a window Gezel opened.
 *
 * Envelope encryption, because the state is far larger than an OS keychain
 * entry holds (Windows Credential Manager: 1,280 characters through
 * @napi-rs/keyring, measured 2026-11-16) and the keyring store does not
 * chunk. A random AES-256-GCM key lives in the SecretStore under the
 * binding's connector secret key; the ciphertext lives in the binding's
 * private state folder as `session.enc`. Removing the binding deletes both.
 * Only cookies for the site's own hosts are kept. Nothing here is ever
 * written to the corpus, a log line or History.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { sameSite } from '@bendyline/gezel';
import { writeFileAtomic } from '@bendyline/gezel-inference/internal/fs/atomic';
import type { SecretStore } from '@bendyline/gezel-inference/internal/secrets/types';
import type { StorageStateLike } from '../../page-capture/types.js';
import { connectorSecretKey } from '../registry.js';

export const SESSION_FILE = 'session.enc';
const PREVIOUS_FILE = 'session.prev.enc';
const TYPE_ID = 'website';

/** What a page looks like signed in versus signed out, captured at sign-in. */
export interface SignInFingerprint {
  finalUrl: string;
  status: number;
  title: string;
  passwordField: boolean;
  words: number;
}

export interface SavedSession {
  version: 1;
  state: StorageStateLike;
  savedAt: string;
  /** Hosts the person signed in to (the binding's sites). */
  hosts: string[];
  /** The page the person ended on, used to check the session still works. */
  probeUrl?: string;
  signedIn?: SignInFingerprint;
  anonymous?: SignInFingerprint;
  /** Signed-in and anonymous looked the same; signed-out cannot be told apart. */
  unverifiable?: boolean;
  lastVerifiedAt?: string;
}

interface KeyBlob {
  v: 1;
  k: string;
}

async function sessionKey(
  secrets: SecretStore,
  bindingId: string,
  create: boolean,
): Promise<Buffer | null> {
  const ref = connectorSecretKey(TYPE_ID, bindingId);
  const raw = await secrets.get(ref);
  if (raw) {
    try {
      const blob = JSON.parse(raw) as KeyBlob;
      const key = Buffer.from(blob.k, 'base64');
      if (blob.v === 1 && key.length === 32) return key;
    } catch {
      /* fall through */
    }
  }
  if (!create) return null;
  const key = randomBytes(32);
  await secrets.set(ref, JSON.stringify({ v: 1, k: key.toString('base64') } satisfies KeyBlob));
  return key;
}

function encrypt(key: Buffer, plain: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from('GZS1'), iv, cipher.getAuthTag(), body]);
}

function decrypt(key: Buffer, data: Buffer): string | null {
  if (data.length < 4 + 12 + 16 || data.subarray(0, 4).toString() !== 'GZS1') return null;
  const iv = data.subarray(4, 16);
  const tag = data.subarray(16, 32);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data.subarray(32)), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** Keep only cookies and storage for the binding's own sites. */
export function limitStateToSites(
  state: StorageStateLike,
  hosts: readonly string[],
): StorageStateLike {
  const scopes = hosts.map((h) => ({ host: h }));
  const cookieHostOk = (domain: string) => {
    const d = domain.replace(/^\./, '').toLowerCase();
    return scopes.some(
      (s) =>
        sameSite(d, s) ||
        s.host.toLowerCase().endsWith(`.${d}`) ||
        d.endsWith(`.${s.host.toLowerCase().replace(/^www\./, '')}`),
    );
  };
  const cookies = (state.cookies as { domain?: string }[]).filter(
    (c) => typeof c.domain === 'string' && cookieHostOk(c.domain),
  );
  const origins = (state.origins as { origin?: string }[]).filter((o) => {
    try {
      return typeof o.origin === 'string' && cookieHostOk(new URL(o.origin).hostname);
    } catch {
      return false;
    }
  });
  return { cookies, origins };
}

export async function readSession(
  stateDir: string,
  secrets: SecretStore,
  bindingId: string,
): Promise<SavedSession | null> {
  const key = await sessionKey(secrets, bindingId, false);
  if (!key) return null;
  for (const file of [SESSION_FILE, PREVIOUS_FILE]) {
    const data = await readFile(join(stateDir, file)).catch(() => null);
    if (!data) continue;
    const plain = decrypt(key, data);
    if (!plain) continue;
    try {
      const parsed = JSON.parse(plain) as SavedSession;
      if (parsed.version === 1 && parsed.state) return parsed;
    } catch {
      /* try the previous generation */
    }
  }
  return null;
}

/** Save a session, keeping the one before it as a fallback. */
export async function writeSession(
  stateDir: string,
  secrets: SecretStore,
  bindingId: string,
  session: SavedSession,
): Promise<void> {
  const key = await sessionKey(secrets, bindingId, true);
  if (!key) throw new Error('could not create a key for the saved sign-in');
  const limited: SavedSession = {
    ...session,
    state: limitStateToSites(session.state, session.hosts),
  };
  const current = join(stateDir, SESSION_FILE);
  await rename(current, join(stateDir, PREVIOUS_FILE)).catch(() => {});
  await writeFileAtomic(current, encrypt(key, JSON.stringify(limited)));
}

/** Forget the sign-in: the key and both generations. */
export async function forgetSession(
  stateDir: string,
  secrets: SecretStore,
  bindingId: string,
): Promise<void> {
  await secrets.delete(connectorSecretKey(TYPE_ID, bindingId)).catch(() => {});
  await rm(join(stateDir, SESSION_FILE), { force: true }).catch(() => {});
  await rm(join(stateDir, PREVIOUS_FILE), { force: true }).catch(() => {});
}

/**
 * Whether a capture looks signed out against the fingerprints taken at
 * sign-in. Conservative: a page that matches the anonymous fingerprint, shows
 * a password field, or was refused counts as signed out.
 */
export function looksSignedOut(
  session: SavedSession,
  observed: {
    finalUrl: string;
    status: number;
    title: string;
    passwordField: boolean;
    words: number;
  },
): boolean {
  if (observed.status === 401 || observed.status === 403) return true;
  if (observed.passwordField && observed.words < 600) return true;
  if (session.unverifiable || !session.anonymous || !session.signedIn) return false;
  const anon = session.anonymous;
  const sameAsAnon = observed.finalUrl === anon.finalUrl && observed.title === anon.title;
  const sameAsSignedIn = observed.title === session.signedIn.title;
  return sameAsAnon && !sameAsSignedIn;
}
