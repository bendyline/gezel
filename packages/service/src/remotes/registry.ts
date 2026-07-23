/**
 * RemotesRegistry — Device A's view of the servers it has paired with for
 * remote model execution. One entry per paired server; A can pair with many.
 *
 * Persisted to `~/.gezel/remotes.json` at mode 0600 (it holds bearer tokens,
 * same posture as `tokens.json`). Writes are serialized through a single
 * promise chain so concurrent add/update/remove can't lose a record. The
 * counterpart on the SERVER side is just the token store — each paired client
 * is one `TokenRecord{kind:'device'}`, so B needs no extra registry.
 */

import { remotesFile as defaultRemotesFile } from '@bendyline/gezel/paths';
import { readSecurityJson, writeSecurityJson } from '../fs/security-json.js';

export interface PairedRemote {
  /** Stable id A assigns to this server = its full identity fingerprint. */
  remoteId: string;
  /** Base URL A reaches the server at, e.g. `https://192.168.1.50:43936`. */
  baseUrl: string;
  /** Human label shown in A's model picker / Remote Servers panel. */
  displayName: string;
  /** Per-device bearer token the server issued A (scope `remote-inference`). */
  token: string;
  /** The server's identity public key (SPKI PEM), pinned at pairing (TOFU). */
  pinnedIdentityKey: string;
  /** Hex SHA-256 of the pinned identity key — the comparable fingerprint. */
  pinnedIdentityFingerprint: string;
  /**
   * The server's current TLS cert (PEM), used as the CA for A's trusting
   * fetch. Refreshed from `/v1/identity` when the server rotates it; the
   * identity signature is what proves continuity, not this cert.
   */
  tlsCertPem?: string;
  /** Scopes the server granted (currently `['remote-inference']`). */
  scopes: string[];
  pairedAt: number;
  /** Last time A successfully reached this server (in-memory unless flushed). */
  lastSeenAt?: number;
}

export interface RemotesRegistry {
  list(): PairedRemote[];
  get(remoteId: string): PairedRemote | null;
  /** Upsert a paired server. Re-pairing the same id or base URL replaces it atomically. */
  add(remote: PairedRemote): Promise<void>;
  /** Patch fields of an existing entry (token rotation, cert refresh, re-pin). */
  update(remoteId: string, patch: Partial<Omit<PairedRemote, 'remoteId'>>): Promise<boolean>;
  /** Forget a server. Returns true if a record was removed. */
  remove(remoteId: string): Promise<boolean>;
  /** Bump `lastSeenAt` in memory (no disk write). */
  touch(remoteId: string): void;
}

export interface CreateRemotesRegistryOptions {
  home: string;
  /** Override the on-disk path. Defaults to `<home>/remotes.json`. */
  filePath?: string;
}

interface PersistedShape {
  version: 1;
  remotes: PairedRemote[];
}

export async function createRemotesRegistry(
  opts: CreateRemotesRegistryOptions,
): Promise<RemotesRegistry> {
  const filePath = opts.filePath ?? defaultRemotesFile(opts.home);
  const byId = new Map<string, PairedRemote>();
  for (const r of await loadPersisted(filePath)) byId.set(r.remoteId, r);

  const persist = async (): Promise<void> => {
    const snapshot: PersistedShape = { version: 1, remotes: Array.from(byId.values()) };
    await writeSecurityJson(filePath, `${JSON.stringify(snapshot, null, 2)}\n`);
  };
  let mutationChain: Promise<void> = Promise.resolve();
  const mutate = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = mutationChain.then(fn);
    mutationChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  return {
    list() {
      return Array.from(byId.values());
    },
    get(remoteId) {
      return byId.get(remoteId) ?? null;
    },
    async add(remote) {
      return mutate(async () => {
        const previous = byId.get(remote.remoteId);
        const normalizedBaseUrl = remote.baseUrl.replace(/\/+$/, '');
        const displaced = Array.from(byId.entries()).filter(
          ([id, entry]) =>
            id !== remote.remoteId && entry.baseUrl.replace(/\/+$/, '') === normalizedBaseUrl,
        );
        for (const [id] of displaced) byId.delete(id);
        byId.set(remote.remoteId, { ...remote });
        try {
          await persist();
        } catch (err) {
          if (previous) byId.set(remote.remoteId, previous);
          else byId.delete(remote.remoteId);
          for (const [id, entry] of displaced) byId.set(id, entry);
          throw err;
        }
      });
    },
    async update(remoteId, patch) {
      return mutate(async () => {
        const existing = byId.get(remoteId);
        if (!existing) return false;
        byId.set(remoteId, { ...existing, ...patch, remoteId });
        try {
          await persist();
        } catch (err) {
          byId.set(remoteId, existing);
          throw err;
        }
        return true;
      });
    },
    async remove(remoteId) {
      return mutate(async () => {
        const existing = byId.get(remoteId);
        if (!existing) return false;
        byId.delete(remoteId);
        try {
          await persist();
        } catch (err) {
          byId.set(remoteId, existing);
          throw err;
        }
        return true;
      });
    },
    touch(remoteId) {
      const r = byId.get(remoteId);
      if (r) r.lastSeenAt = Date.now();
    },
  };
}

async function loadPersisted(filePath: string): Promise<PairedRemote[]> {
  return (
    (await readSecurityJson(filePath, 'paired remotes registry', (raw) => decodePersisted(raw))) ??
    []
  );
}

function decodePersisted(raw: string): PairedRemote[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object') throw new Error('expected an object');
  const shape = parsed as Partial<PersistedShape>;
  if (shape.version !== 1 || !Array.isArray(shape.remotes)) {
    throw new Error('unsupported version or missing remotes array');
  }
  const out: PairedRemote[] = [];
  for (const entry of shape.remotes) {
    if (!entry || typeof entry !== 'object') throw new Error('invalid remote record');
    const e = entry as Partial<PairedRemote>;
    if (
      typeof e.remoteId !== 'string' ||
      typeof e.baseUrl !== 'string' ||
      typeof e.displayName !== 'string' ||
      typeof e.token !== 'string' ||
      typeof e.pinnedIdentityKey !== 'string' ||
      typeof e.pinnedIdentityFingerprint !== 'string' ||
      !Array.isArray(e.scopes) ||
      typeof e.pairedAt !== 'number'
    ) {
      throw new Error('invalid remote record fields');
    }
    out.push({
      remoteId: e.remoteId,
      baseUrl: e.baseUrl,
      displayName: e.displayName,
      token: e.token,
      pinnedIdentityKey: e.pinnedIdentityKey,
      pinnedIdentityFingerprint: e.pinnedIdentityFingerprint,
      scopes: e.scopes.filter((s): s is string => typeof s === 'string'),
      pairedAt: e.pairedAt,
      ...(typeof e.tlsCertPem === 'string' ? { tlsCertPem: e.tlsCertPem } : {}),
      ...(typeof e.lastSeenAt === 'number' ? { lastSeenAt: e.lastSeenAt } : {}),
    });
  }
  return out;
}
