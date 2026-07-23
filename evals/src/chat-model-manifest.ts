/**
 * Shared, cached reader for a chat model's catalog manifest.
 *
 * The eval harness reads model manifests directly off disk (rather than
 * via `@bendyline/gezel-catalog`) so we don't pull the whole catalog
 * package into the eval surface. Several call sites need one field or
 * another off the same file (`evalHints`, `parameterSize`, `tuning`), so
 * they funnel through this one walk instead of hand-rolling the
 * prefix/path/read/parse each time. `null` (cached) means "no manifest";
 * we don't pay the filesystem round-trip twice per model.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeChatModelCatalogId } from '@bendyline/gezel';
import { gildeDataDir } from '@bendyline/gezel-catalog';

const cache = new Map<string, Record<string, unknown> | null>();

/**
 * Read and JSON-parse `<gilde>/data/chat-models/<prefix>/<id>/manifest.json`.
 * Returns `undefined` when the manifest is missing or malformed (a bad
 * data file must never crash a trial). Cached per-process.
 */
export function readChatModelManifest(modelId: string): Record<string, unknown> | undefined {
  if (cache.has(modelId)) return cache.get(modelId) ?? undefined;
  const catalogId = normalizeChatModelCatalogId(modelId) ?? modelId;
  // Two-character prefix: `nemotron3-super-120b` → `ne`. Matches the
  // catalog's on-disk layout (`chat-models/ne/nemotron3-super-120b/`).
  const prefix = catalogId.slice(0, 2).toLowerCase();
  const path = join(gildeDataDir(), 'chat-models', prefix, catalogId, 'manifest.json');
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    cache.set(modelId, parsed);
    return parsed;
  } catch {
    cache.set(modelId, null);
    return undefined;
  }
}

/** The manifest's declared `parameterSize` (e.g. `"27B"`), if any. */
export function modelParameterSize(modelId: string): string | undefined {
  const size = readChatModelManifest(modelId)?.parameterSize;
  return typeof size === 'string' ? size : undefined;
}
