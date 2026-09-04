/**
 * Signed-registry consumption (knowledge-catalogs.md Phase 6): fetch a
 * publisher's `_knowledge/registry/index.json`, verify its Ed25519 signature
 * against keyId-indexed trust anchors, and locate archive coordinates.
 *
 * Trust posture: the registry only LOCATES bytes. Content trust stays with
 * the coordinate's `contentDigest` — every consumer re-hashes the downloaded
 * archive against the digest it already trusted, so a compromised registry
 * (or CDN) can at worst fail to locate, never substitute content. Signature
 * verification here protects the locate step itself: an unverified registry
 * cannot steer downloads at attacker-sized garbage or hide/reorder releases.
 */

import type { KnowledgeRegistryEntry, KnowledgeRegistryIndex } from '@bendyline/gezk';
import { KnowledgeRegistryIndexSchema } from '@bendyline/gezk';
import type { KnowledgeTrustAnchor } from '../signatures/signing.js';
import { verifyRegistryIndex } from '../signatures/signing.js';

/** Registries are small documents; anything past this is not a registry. */
const DEFAULT_MAX_REGISTRY_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

export type KnowledgeRegistryFetchCode = 'http' | 'too-large' | 'invalid' | 'unsigned-or-untrusted';

export class KnowledgeRegistryFetchError extends Error {
  readonly code: KnowledgeRegistryFetchCode;
  constructor(code: KnowledgeRegistryFetchCode, message: string) {
    super(message);
    this.name = 'KnowledgeRegistryFetchError';
    this.code = code;
  }
}

export interface FetchKnowledgeRegistryOptions {
  anchors: readonly KnowledgeTrustAnchor[];
  maxBytes?: number;
  /** Budget for the whole fetch when no `signal` is supplied. */
  timeoutMs?: number;
  /** Caller-owned deadline (the daemon passes a suspend-aware signal). */
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/**
 * Fetch + schema-parse + signature-verify a registry. Throws
 * `KnowledgeRegistryFetchError`; never returns an unverified document.
 */
export async function fetchKnowledgeRegistry(
  url: string,
  opts: FetchKnowledgeRegistryOptions,
): Promise<{ registry: KnowledgeRegistryIndex; keyId: string }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_REGISTRY_BYTES;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      signal: opts.signal ?? AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      redirect: 'follow',
      headers: { accept: 'application/json' },
    });
  } catch (err) {
    throw new KnowledgeRegistryFetchError(
      'http',
      `registry fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!response.ok) {
    throw new KnowledgeRegistryFetchError('http', `registry fetch failed: HTTP ${response.status}`);
  }
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > maxBytes) {
    throw new KnowledgeRegistryFetchError(
      'too-large',
      `registry declares ${declared} bytes (cap ${maxBytes})`,
    );
  }
  const body = Buffer.from(await response.arrayBuffer());
  if (body.byteLength > maxBytes) {
    throw new KnowledgeRegistryFetchError(
      'too-large',
      `registry body is ${body.byteLength} bytes (cap ${maxBytes})`,
    );
  }

  let registry: KnowledgeRegistryIndex;
  try {
    registry = KnowledgeRegistryIndexSchema.parse(JSON.parse(body.toString('utf8')));
  } catch (err) {
    throw new KnowledgeRegistryFetchError(
      'invalid',
      `registry is not a valid gezk-registry document: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const verdict = verifyRegistryIndex(registry, opts.anchors);
  if (!verdict.ok) {
    throw new KnowledgeRegistryFetchError(
      'unsigned-or-untrusted',
      `registry signature rejected (${verdict.reason}${verdict.detail ? `: ${verdict.detail}` : ''})`,
    );
  }
  return { registry, keyId: verdict.keyId };
}

/**
 * Locate the row for an exact trusted coordinate. `contentDigest`, when
 * given, must match the row — a registry that renames a digest under an
 * existing (catalogId, version) simply fails to locate.
 */
export function findRegistryEntry(
  registry: KnowledgeRegistryIndex,
  ref: { publisherId: string; catalogId: string; version: string; contentDigest?: string },
): KnowledgeRegistryEntry | null {
  if (registry.publisher.id !== ref.publisherId) return null;
  const entry = registry.catalogs.find(
    (c) => c.catalogId === ref.catalogId && c.version === ref.version,
  );
  if (!entry) return null;
  if (ref.contentDigest && entry.contentDigest !== ref.contentDigest.toLowerCase()) return null;
  return entry;
}

/**
 * Compare two catalog versions (CalVer-style dotted numerics, e.g.
 * `2026.08.1`). Non-numeric segments fall back to lexicographic comparison
 * so unconventional versions still order deterministically.
 */
export function compareCatalogVersions(a: string, b: string): number {
  const as = a.split('.');
  const bs = b.split('.');
  const len = Math.max(as.length, bs.length);
  for (let i = 0; i < len; i++) {
    const av = as[i] ?? '';
    const bv = bs[i] ?? '';
    const an = /^\d+$/.test(av) ? Number(av) : null;
    const bn = /^\d+$/.test(bv) ? Number(bv) : null;
    if (an !== null && bn !== null) {
      if (an !== bn) return an < bn ? -1 : 1;
    } else if (av !== bv) {
      return av < bv ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Rows offering a strictly newer version of an installed catalog, newest
 * first. Rows whose version does not exceed the installed one are ignored —
 * a registry cannot "update" an install to an older or renamed release.
 */
export function newerRegistryEntries(
  registry: KnowledgeRegistryIndex,
  installed: { catalogId: string; version: string },
): KnowledgeRegistryEntry[] {
  return registry.catalogs
    .filter(
      (c) =>
        c.catalogId === installed.catalogId &&
        compareCatalogVersions(c.version, installed.version) > 0,
    )
    .sort((x, y) => compareCatalogVersions(y.version, x.version));
}
