/**
 * Loader for per-model `evalHints` declared on `ChatModelManifestSchema`.
 *
 * The eval harness reads model manifests directly off disk (via the
 * `gildeDataDir()` resolver rather than `CatalogService`) — the only
 * thing we need is one optional block. `null` (cached) for "no manifest
 * found" so we don't pay the filesystem round-trip twice per trial.
 *
 * Wild-caught (nemotron-super tictactoe): the model
 * writes idiomatic 1996-byte tic-tac-toe games — fully functional —
 * that land 52 bytes under the shared anti-stub floor of 2048. Per-
 * model `inlineJsMinBytes` lets the catalog calibrate the floor
 * against the model's actual output style. See {@link EvalHints}.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type EvalHints, EvalHintsSchema, normalizeChatModelCatalogId } from '@bendyline/gezel';
import { gildeDataDir } from '@bendyline/gezel-catalog';

const cache = new Map<string, EvalHints | null>();

/**
 * Read the `evalHints` block from `<gilde>/data/chat-models/<prefix>/<modelId>/manifest.json`,
 * if present. Returns `undefined` when the manifest doesn't exist or
 * doesn't declare evalHints. Cached per-process.
 */
export function loadModelEvalHints(modelId: string): EvalHints | undefined {
  if (cache.has(modelId)) {
    const cached = cache.get(modelId);
    return cached ?? undefined;
  }
  const catalogId = normalizeChatModelCatalogId(modelId) ?? modelId;
  // Two-character prefix: `nemotron3-super-120b` → `ne`. Matches the
  // catalog's on-disk layout (`chat-models/ne/nemotron3-super-120b/`).
  const prefix = catalogId.slice(0, 2).toLowerCase();
  const path = join(gildeDataDir(), 'chat-models', prefix, catalogId, 'manifest.json');
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    cache.set(modelId, null);
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as { evalHints?: unknown };
    if (!parsed.evalHints) {
      cache.set(modelId, null);
      return undefined;
    }
    const result = EvalHintsSchema.parse(parsed.evalHints);
    cache.set(modelId, result);
    return result;
  } catch {
    // Malformed manifest or evalHints — silently treat as unset so a
    // bad data file doesn't crash trials.
    cache.set(modelId, null);
    return undefined;
  }
}

/**
 * Test-only escape hatch: drop the cache so unit tests can re-load
 * after mutating manifests.
 */
export function _clearModelEvalHintsCacheForTests(): void {
  cache.clear();
}
