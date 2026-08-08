import { createHash, randomBytes } from 'node:crypto';
import { posix } from 'node:path';
import type { PreviewSource } from '@bendyline/gezel';

/** Preview leases are deliberately brief: enough for a page and its assets,
 * but not a durable bearer that can sit in browser history for days. */
export const DEFAULT_PREVIEW_CAPABILITY_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_PREVIEW_CAPABILITY_ABSOLUTE_TTL_MS = 2 * 60 * 60 * 1000;

interface PreviewCapabilityRecord {
  projectId: string;
  scopes: PreviewCapabilityScope[];
  idleExpiresAtMs: number;
  absoluteExpiresAtMs: number;
  createdAtMs: number;
}

export interface PreviewCapabilityScope {
  source: PreviewSource;
  path: string;
  subtree: boolean;
}

export interface MintedPreviewCapability {
  token: string;
  entryPath: string;
  scopePath: string;
  expiresAt: string;
}

export type PreviewCapabilityDecision =
  | { ok: true; path: string }
  | { ok: false; reason: 'invalid' | 'expired' | 'scope' };

export interface PreviewCapabilityStoreOptions {
  ttlMs?: number;
  absoluteTtlMs?: number;
  now?: () => number;
  maxEntries?: number;
}

/**
 * In-memory, per-launch capability registry for sandboxed previews.
 *
 * Raw capability values are returned once to the authenticated renderer but
 * only a SHA-256 digest is retained here. A lease is bound to one source,
 * project, and entry-directory subtree; possession cannot be reused to browse
 * another project or another part of the same tree. Expiry and a small entry
 * cap keep abandoned browser URLs from accumulating indefinitely.
 */
export class PreviewCapabilityStore {
  private readonly records = new Map<string, PreviewCapabilityRecord>();
  private readonly ttlMs: number;
  private readonly absoluteTtlMs: number;
  private readonly now: () => number;
  private readonly maxEntries: number;

  constructor(opts: PreviewCapabilityStoreOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_PREVIEW_CAPABILITY_TTL_MS;
    this.absoluteTtlMs = opts.absoluteTtlMs ?? DEFAULT_PREVIEW_CAPABILITY_ABSOLUTE_TTL_MS;
    this.now = opts.now ?? Date.now;
    this.maxEntries = opts.maxEntries ?? 2_048;
    if (!Number.isFinite(this.ttlMs) || this.ttlMs <= 0) {
      throw new Error('preview capability ttlMs must be positive');
    }
    if (!Number.isFinite(this.absoluteTtlMs) || this.absoluteTtlMs < this.ttlMs) {
      throw new Error('preview capability absoluteTtlMs must be at least ttlMs');
    }
    if (!Number.isInteger(this.maxEntries) || this.maxEntries <= 0) {
      throw new Error('preview capability maxEntries must be a positive integer');
    }
  }

  mint(input: {
    source: PreviewSource;
    projectId: string;
    entryPath: string;
    /** Explicit, trusted cross-source reads declared by a project type page. */
    additionalScopes?: Array<{ source: PreviewSource; path: string; subtree?: boolean }>;
  }): MintedPreviewCapability {
    const normalized = normalizePreviewPath(input.entryPath);
    if (normalized === null) throw new Error('invalid preview path');
    const directoryEntry = /[\\/]$/.test(input.entryPath);
    const scopePath = directoryEntry ? normalized : previewParentPath(normalized);
    const createdAtMs = this.now();
    const idleExpiresAtMs = createdAtMs + this.ttlMs;
    const absoluteExpiresAtMs = createdAtMs + this.absoluteTtlMs;
    const token = randomBytes(32).toString('base64url');
    this.prune(createdAtMs);
    const additionalScopes = (input.additionalScopes ?? []).map((scope) => {
      const path = normalizePreviewPath(scope.path);
      if (path === null) throw new Error('invalid additional preview scope');
      return { source: scope.source, path, subtree: scope.subtree === true };
    });
    const outsideInRuntimeScopes = outsideInPlayerScopes(input.source, normalized);
    this.records.set(tokenDigest(token), {
      projectId: input.projectId,
      scopes: [
        { source: input.source, path: scopePath, subtree: true },
        ...outsideInRuntimeScopes,
        ...additionalScopes,
      ],
      idleExpiresAtMs,
      absoluteExpiresAtMs,
      createdAtMs,
    });
    this.enforceEntryLimit();
    return {
      token,
      entryPath: normalized,
      scopePath,
      expiresAt: new Date(idleExpiresAtMs).toISOString(),
    };
  }

  authorize(input: {
    token: string;
    source: PreviewSource;
    projectId: string;
    path: string;
  }): PreviewCapabilityDecision {
    if (!/^[A-Za-z0-9_-]{43}$/.test(input.token)) return { ok: false, reason: 'invalid' };
    const digest = tokenDigest(input.token);
    const record = this.records.get(digest);
    if (!record) return { ok: false, reason: 'invalid' };
    const now = this.now();
    if (record.idleExpiresAtMs <= now || record.absoluteExpiresAtMs <= now) {
      this.records.delete(digest);
      return { ok: false, reason: 'expired' };
    }
    const normalized = normalizePreviewPath(input.path);
    if (
      normalized === null ||
      record.projectId !== input.projectId ||
      !record.scopes.some(
        (scope) =>
          scope.source === input.source &&
          (scope.subtree ? pathIsInScope(normalized, scope.path) : normalized === scope.path),
      )
    ) {
      return { ok: false, reason: 'scope' };
    }
    // Active previews may load data lazily long after the first HTML request.
    // Refresh the short idle lease only after an in-scope request, while the
    // absolute cap bounds how long a URL can survive in browser history.
    record.idleExpiresAtMs = Math.min(now + this.ttlMs, record.absoluteExpiresAtMs);
    return { ok: true, path: normalized };
  }

  private prune(now: number): void {
    for (const [digest, record] of this.records) {
      if (record.idleExpiresAtMs <= now || record.absoluteExpiresAtMs <= now) {
        this.records.delete(digest);
      }
    }
  }

  private enforceEntryLimit(): void {
    while (this.records.size > this.maxEntries) {
      let oldestKey: string | undefined;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [key, record] of this.records) {
        if (record.createdAtMs < oldestAt) {
          oldestAt = record.createdAtMs;
          oldestKey = key;
        }
      }
      if (!oldestKey) break;
      this.records.delete(oldestKey);
    }
  }
}

/**
 * An outside-in HTML page may share the exact Squisq player file from an
 * ancestor `_squisq` directory. Grant those fixed filenames, never the
 * surrounding directories, so a nested page can load its runtime without
 * turning the preview capability into general workspace read authority.
 */
function outsideInPlayerScopes(source: PreviewSource, entryPath: string): PreviewCapabilityScope[] {
  if (source === 'type' || !/\.html?$/i.test(entryPath)) return [];
  const directories: string[] = [];
  let current = previewParentPath(entryPath);
  for (let depth = 0; depth < 32; depth++) {
    directories.push(current);
    if (!current) break;
    current = previewParentPath(current);
  }
  if (!directories.includes('')) directories.push('');
  return directories.map((directory) => ({
    source,
    path: directory ? `${directory}/_squisq/squisq-player.js` : '_squisq/squisq-player.js',
    subtree: false,
  }));
}

/** Normalize an API/URL-relative preview path without accepting traversal. */
export function normalizePreviewPath(input: string): string | null {
  if (typeof input !== 'string' || input.includes('\0')) return null;
  const slashPath = input.replaceAll('\\', '/');
  if (slashPath.startsWith('/') || /^[A-Za-z]:\//.test(slashPath)) return null;
  const parts = slashPath.split('/');
  if (parts.some((part) => part === '..')) return null;
  const normalized = posix.normalize(slashPath);
  if (normalized === '.') return '';
  if (normalized === '..' || normalized.startsWith('../')) return null;
  return normalized.replace(/^\.\//, '').replace(/\/$/, '');
}

export function encodePreviewPath(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

/**
 * Canonical path shape shared by first-party output-pane previews and
 * agent-driven browser previews. Keeping this in one place prevents either
 * caller from drifting away from the capability route's segment ordering.
 */
export function previewCapabilityPath(input: {
  token: string;
  source: PreviewSource;
  projectId: string;
  entryPath: string;
}): string {
  const suffix = encodePreviewPath(input.entryPath);
  return `/preview/${encodeURIComponent(input.token)}/${input.source}/${encodeURIComponent(input.projectId)}/${suffix}`;
}

function previewParentPath(path: string): string {
  if (!path) return '';
  const parent = posix.dirname(path);
  return parent === '.' ? '' : parent;
}

function pathIsInScope(path: string, scopePath: string): boolean {
  return scopePath === '' || path === scopePath || path.startsWith(`${scopePath}/`);
}

function tokenDigest(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}
