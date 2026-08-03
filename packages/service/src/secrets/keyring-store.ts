import { randomUUID } from 'node:crypto';
import { Entry } from '@napi-rs/keyring';
import {
  LEGACY_DEVICE_IDENTITY_ACCOUNT,
  SecretBackendUnavailableError,
  type SecretKey,
  type SecretStore,
  type SecretStoreBackend,
  SecretStoreCorruptError,
  stringifySecretKey,
  toolsetKeyPrefix,
} from './types.js';

const SERVICE_NAME = 'gezel';
/** Account used to store the index of known secret keys so `listForToolset`
 *  can enumerate without scanning the whole keychain. Keyrings don't
 *  generally support prefix queries, so we maintain this ourselves. */
const INDEX_ACCOUNT = '__gezel_index__';

/**
 * Read-cache tuning. The OS keyring is a slow, prompt-capable round-trip on
 * every single read, and several subsystems (Settings config polls, per-turn
 * session rebuilds, the outbound credential-leak screen) each enumerate
 * overlapping keys — so an otherwise-idle app fans out dozens of reads a
 * minute for the same handful of secrets.
 *
 * Worse: when the login keyring is locked mid-session (on Linux the common
 * trigger is gnome-keyring respawning without the login password after a
 * crash), every read of a stored-but-locked secret raises a Secret Service
 * UNLOCK PROMPT. Uncached, that storm re-fires on every timer tick — the
 * "keyring prompt every minute" incident. The positive cache collapses
 * the duplicate reads; the escalating failure backoff stops a locked keyring
 * from being re-probed (and re-prompting) on every tick, retrying at most once
 * per (doubling) window up to MAX_BACKOFF_MS.
 */
const POSITIVE_TTL_MS = 5_000;
const INITIAL_BACKOFF_MS = 15_000;
const MAX_BACKOFF_MS = 300_000;

/** Minimal surface of `@napi-rs/keyring`'s `Entry` that this store depends on.
 *  Injectable so tests can exercise the cache/backoff without a real keychain
 *  (and so a locked keyring can be simulated deterministically). */
export interface KeyringEntry {
  getPassword(): string | null;
  setPassword(value: string): void;
  deletePassword(): void;
}
export type KeyringEntryFactory = (service: string, account: string) => KeyringEntry;

export interface KeyringSecretStoreOptions {
  /** Override the `Entry` constructor (tests). Defaults to `@napi-rs/keyring`. */
  entryFactory?: KeyringEntryFactory;
  /** Override the clock (tests). Defaults to `Date.now`. */
  now?: () => number;
  /** Current home's identity scope, used for backend migration exports. */
  identityScope?: string;
}

interface CacheSlot {
  value: string | null;
  expiresAt: number;
  /** Backoff window of the last failed read; 0 after a successful read. */
  backoffMs: number;
  error?: SecretBackendUnavailableError;
}

const defaultEntryFactory: KeyringEntryFactory = (service, account) => new Entry(service, account);

/**
 * Native OS keychain-backed SecretStore. macOS → Keychain; Windows →
 * Credential Manager; Linux → Secret Service (gnome-keyring / kwallet).
 *
 * Indexing: the OS keyrings don't support prefix enumeration, so we
 * maintain a JSON array of stored keys in a sentinel entry. The array is
 * small (one entry per installed toolset field) and is rewritten on every
 * set/delete. Atomicity note: a crash mid-write can leave the index
 * slightly out of sync with the actual entries; reads handle this by
 * treating `null` get results as absence.
 *
 * Caching: every read goes through an in-memory cache (see the TTL constants
 * above). Writes (`set`/`delete`) update the cache in place, so reads are
 * always process-consistent; a change made by another process surfaces within
 * POSITIVE_TTL_MS. `FileSecretStore` caches similarly.
 */
export class KeyringSecretStore implements SecretStore {
  readonly backend: SecretStoreBackend = 'keyring';

  private readonly entryFactory: KeyringEntryFactory;
  private readonly now: () => number;
  private readonly identityScope: string | undefined;
  private readonly cache = new Map<string, CacheSlot>();

  constructor(opts: KeyringSecretStoreOptions = {}) {
    this.entryFactory = opts.entryFactory ?? defaultEntryFactory;
    this.now = opts.now ?? Date.now;
    this.identityScope = opts.identityScope;
  }

  async get(key: SecretKey): Promise<string | null> {
    return this.readEntry(stringifySecretKey(key));
  }

  async has(key: SecretKey): Promise<boolean> {
    return (await this.get(key)) !== null;
  }

  async set(key: SecretKey, value: string): Promise<void> {
    const name = stringifySecretKey(key);
    this.writeEntry(name, value);
    // Identity accounts are known from GEZEL_HOME and never need global
    // enumeration. Keeping them out of the legacy login-global index is what
    // lets a new scoped identity boot even when an older signed build left an
    // unreadable `__gezel_index__` item behind.
    if (key.kind !== 'deviceIdentity') await this.addToIndex(name);
  }

  async delete(key: SecretKey): Promise<void> {
    const name = stringifySecretKey(key);
    this.deleteEntry(name);
    if (key.kind !== 'deviceIdentity') await this.removeFromIndex(name);
  }

  async listForToolset(toolsetId: string): Promise<string[]> {
    const prefix = toolsetKeyPrefix(toolsetId);
    const index = await this.readIndex();
    return index.filter((name) => name.startsWith(prefix)).map((name) => name.slice(prefix.length));
  }

  /** Internal backend-migration seam; existing keyring values always win. */
  async importEntries(entries: ReadonlyMap<string, string>, overwrite = false): Promise<void> {
    const scopedIdentityAccount = this.scopedIdentityAccount();
    const hasScopedIdentity = scopedIdentityAccount ? entries.has(scopedIdentityAccount) : false;
    for (const [name, value] of entries) {
      // Moving an old file-backed store into the keyring must not recreate the
      // login-global identity account. It may already exist under another
      // build's ACL, which is the collision this namespace is designed to end.
      if (name === LEGACY_DEVICE_IDENTITY_ACCOUNT && hasScopedIdentity) continue;
      const targetName =
        name === LEGACY_DEVICE_IDENTITY_ACCOUNT && scopedIdentityAccount
          ? scopedIdentityAccount
          : name;
      if (!overwrite && this.readEntry(targetName) !== null) continue;
      this.writeEntry(targetName, value);
      if (!isDeviceIdentityAccount(targetName)) await this.addToIndex(targetName);
    }
  }

  async exportEntries(): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const name of await this.readIndex()) {
      // Pre-v2 indexes can contain the singleton identity. Probe it below so
      // a retained but inaccessible legacy item does not prevent exporting a
      // healthy scoped identity.
      if (isDeviceIdentityAccount(name)) continue;
      const value = this.readEntry(name);
      if (value !== null) out.set(name, value);
    }

    const scopedName = this.scopedIdentityAccount();
    const scopedValue = scopedName ? this.readEntry(scopedName) : null;
    if (scopedName && scopedValue !== null) {
      out.set(scopedName, scopedValue);
    } else {
      const legacyValue = this.readEntry(LEGACY_DEVICE_IDENTITY_ACCOUNT);
      if (legacyValue !== null) out.set(LEGACY_DEVICE_IDENTITY_ACCOUNT, legacyValue);
    }
    return out;
  }

  private scopedIdentityAccount(): string | undefined {
    return this.identityScope === undefined ? undefined : `deviceIdentity:${this.identityScope}`;
  }

  private readEntry(account: string): string | null {
    const now = this.now();
    const hit = this.cache.get(account);
    if (hit && now < hit.expiresAt) {
      if (hit.error) throw hit.error;
      return hit.value;
    }
    let value: string | null;
    try {
      value = this.entryFactory(SERVICE_NAME, account).getPassword() ?? null;
    } catch (cause) {
      if (isMissingEntry(cause)) {
        this.cache.set(account, {
          value: null,
          expiresAt: now + POSITIVE_TTL_MS,
          backoffMs: 0,
        });
        return null;
      }
      // Locked collections and backend outages must not masquerade as a
      // missing credential. Cache the error and back off, doubling the
      // window on repeated failure so a persistently locked keyring is retried
      // at most every MAX_BACKOFF_MS instead of on every timer tick. Probe
      // failures at boot are handled separately in `probeKeyringAvailable`.
      const backoffMs =
        hit && hit.backoffMs > 0 ? Math.min(hit.backoffMs * 2, MAX_BACKOFF_MS) : INITIAL_BACKOFF_MS;
      const error = new SecretBackendUnavailableError(
        'keyring',
        `OS keychain is unavailable while reading ${account}`,
        { cause },
      );
      this.cache.set(account, { value: null, expiresAt: now + backoffMs, backoffMs, error });
      throw error;
    }
    this.cache.set(account, { value, expiresAt: now + POSITIVE_TTL_MS, backoffMs: 0 });
    return value;
  }

  private writeEntry(account: string, value: string): void {
    try {
      this.entryFactory(SERVICE_NAME, account).setPassword(value);
    } catch (cause) {
      throw new SecretBackendUnavailableError(
        'keyring',
        `OS keychain is unavailable while writing ${account}`,
        { cause },
      );
    }
    this.cache.set(account, { value, expiresAt: this.now() + POSITIVE_TTL_MS, backoffMs: 0 });
  }

  private deleteEntry(account: string): void {
    try {
      this.entryFactory(SERVICE_NAME, account).deletePassword();
    } catch (error) {
      if (!isMissingEntry(error))
        throw new SecretBackendUnavailableError(
          'keyring',
          `OS keychain is unavailable while deleting ${account}`,
          { cause: error },
        );
      // entry may already be gone — tolerate
    }
    this.cache.set(account, { value: null, expiresAt: this.now() + POSITIVE_TTL_MS, backoffMs: 0 });
  }

  private async readIndex(): Promise<string[]> {
    const raw = this.readEntry(INDEX_ACCOUNT);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) {
        throw new SecretStoreCorruptError('OS keychain secret index is not an array');
      }
      return parsed.filter((v) => typeof v === 'string');
    } catch (error) {
      if (error instanceof SecretStoreCorruptError) throw error;
      throw new SecretStoreCorruptError('OS keychain secret index is malformed', { cause: error });
    }
  }

  private async writeIndex(names: string[]): Promise<void> {
    this.writeEntry(INDEX_ACCOUNT, JSON.stringify(names));
  }

  private async addToIndex(name: string): Promise<void> {
    const index = await this.readIndex();
    if (index.includes(name)) return;
    index.push(name);
    await this.writeIndex(index);
  }

  private async removeFromIndex(name: string): Promise<void> {
    const index = await this.readIndex();
    const next = index.filter((n) => n !== name);
    if (next.length === index.length) return;
    await this.writeIndex(next);
  }
}

function isDeviceIdentityAccount(name: string): boolean {
  return name === LEGACY_DEVICE_IDENTITY_ACCOUNT || name.startsWith('deviceIdentity:');
}

function isMissingEntry(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no matching entry|not found|no such item|item does not exist|missing entry/i.test(
    message,
  );
}

/**
 * Probe the keyring backend with a sentinel round-trip. Returns null on
 * success, a reason string on failure. Keep this separate from the class
 * so the factory can decide before any real secret goes near the
 * keyring.
 *
 * Every probe uses a fresh account. A process crash between set and delete
 * can leave an item behind; reusing one fixed account would then turn that
 * harmless orphan into a cross-signature duplicate-item boot failure.
 */
export function probeKeyringAvailable(
  opts: { entryFactory?: KeyringEntryFactory; probeId?: string } = {},
): string | null {
  const probeAccount = `__gezel_probe__:${opts.probeId ?? randomUUID()}`;
  const probeValue = 'ok';
  const entryFactory = opts.entryFactory ?? defaultEntryFactory;
  let entry: KeyringEntry | null = null;
  let wrote = false;
  try {
    entry = entryFactory(SERVICE_NAME, probeAccount);
    entry.setPassword(probeValue);
    wrote = true;
    const got = entry.getPassword();
    entry.deletePassword();
    wrote = false;
    if (got !== probeValue) {
      return `probe value mismatch (got ${JSON.stringify(got)})`;
    }
    return null;
  } catch (err) {
    // A failed read should not leak the just-created sentinel. Cleanup is
    // best-effort so the original diagnostic remains the one callers see.
    if (wrote && entry) {
      try {
        entry.deletePassword();
      } catch {
        // A unique account makes any orphan harmless to later probes.
      }
    }
    return err instanceof Error ? err.message : String(err);
  }
}
