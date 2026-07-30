/**
 * Which install sources a catalog chat-model ships, and a guard that stops
 * a trial before warm when the chosen local engine can't run the model.
 *
 * A manifest can be perfectly valid yet carry only some engine sources —
 * `nemotron3-super-120b-q4`, for instance, is GGUF-only (no MLX quant
 * exists upstream). Combined with the Apple-Silicon `defaultProvider()` = MLX
 * default, a bare `pnpm eval:run … --model nemotron3-…` on a Mac would
 * otherwise pick MLX, find no MLX weights, and fail deep in warm with an
 * opaque error several seconds (or a download) later. This guard turns that
 * into an instant, actionable message naming the engine to use instead.
 *
 * Source presence is read from the catalog's resolved `index.json` — the
 * same merged (identity + version) view the runtime resolves against — so it
 * never disagrees with what would actually be installed. Reading raw
 * per-model `manifest.json` files would be subtler: source blocks live in the
 * version payload, and only the build-manifest "fat root" happens to mirror
 * them.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeChatModelCatalogId } from '@bendyline/gezel';
import { gildeDataDir } from '@bendyline/gezel-catalog';
import { type ChatProvider, isLocalEngine } from './providers.ts';

export interface ChatModelSources {
  ollama: boolean;
  llamaCpp: boolean;
  mlx: boolean;
  ds4: boolean;
}

/**
 * What the catalog says a *currently correct* install of this model looks
 * like, per engine. Compared against the `manifest.json` an install writes
 * so the warm cache can tell "already present" apart from "already present
 * but built from weights the catalog has since moved off".
 *
 * `catalogVersion` is the coarse signal (always present); `sha256` /
 * `huggingfaceRepo` are the precise ones and catch the case where a version
 * bump repoints at different upstream weights (a repo move, a requant).
 * `draftFilename` is separate because MTP/speculative-decoding sidecars were
 * added to existing models — an install predating them is complete by the
 * old contract yet misses the draft weights the engine now expects.
 */
export interface ChatModelInstallIdentity {
  catalogVersion?: string;
  sha256?: string;
  huggingfaceRepo?: string;
  weightsFilename?: string;
  draftFilename?: string;
}

interface EngineBlock {
  huggingfaceRepo?: string;
  filename?: string;
  sha256?: string;
  disabledReason?: unknown;
  draftModel?: { filename?: string };
}

interface IndexedModel {
  sources: ChatModelSources;
  version?: string;
  blocks: Partial<Record<'llamaCpp' | 'mlx' | 'ds4', EngineBlock>>;
}

let indexCache: Map<string, IndexedModel> | null = null;

function loadIndex(): Map<string, IndexedModel> {
  if (indexCache) return indexCache;
  const path = join(gildeDataDir(), 'chat-models', 'index.json');
  const map = new Map<string, IndexedModel>();
  try {
    const idx = JSON.parse(readFileSync(path, 'utf8')) as {
      entries?: Array<{
        manifest?: {
          id?: string;
          version?: string;
          ollama?: unknown;
          llamaCpp?: EngineBlock;
          mlx?: EngineBlock;
          ds4?: EngineBlock;
        };
      }>;
    };
    for (const entry of idx.entries ?? []) {
      const man = entry.manifest;
      if (!man?.id) continue;
      // A `disabledReason` on the mlx block marks a known-broken MLX build.
      // Treat it as NO mlx source so `assertLocalEngineSource('mlx', …)`
      // errors clearly with a "use --provider llama-cpp" hint instead of
      // the model appearing MLX-capable and crashing on load.
      const mlxBlock = man.mlx;
      map.set(man.id, {
        sources: {
          ollama: Boolean(man.ollama),
          llamaCpp: Boolean(man.llamaCpp),
          mlx: Boolean(man.mlx) && !mlxBlock?.disabledReason,
          ds4: Boolean(man.ds4),
        },
        ...(man.version ? { version: man.version } : {}),
        blocks: {
          ...(man.llamaCpp ? { llamaCpp: man.llamaCpp } : {}),
          ...(man.mlx ? { mlx: man.mlx } : {}),
          ...(man.ds4 ? { ds4: man.ds4 } : {}),
        },
      });
    }
  } catch {
    // No / unreadable index — return an empty map so callers treat every
    // model as "unknown" and defer to downstream warm rather than crash.
  }
  indexCache = map;
  return map;
}

/**
 * The catalog's expected install identity for a model on one engine, or
 * `undefined` when the id / engine pair isn't in the index (cloud model,
 * unbuilt index, or an engine this model ships no weights for). Callers
 * treat `undefined` as "nothing to compare against" and leave the install
 * alone — never as "stale".
 */
export function chatModelInstallIdentity(
  modelId: string,
  engine: 'llama-cpp' | 'mlx' | 'ds4',
): ChatModelInstallIdentity | undefined {
  const id = normalizeChatModelCatalogId(modelId) ?? modelId;
  const model = loadIndex().get(id);
  if (!model) return undefined;
  const key = engine === 'llama-cpp' ? 'llamaCpp' : engine;
  const block = model.blocks[key];
  if (!block) return undefined;
  return {
    ...(model.version ? { catalogVersion: model.version } : {}),
    ...(block.sha256 ? { sha256: block.sha256 } : {}),
    ...(block.huggingfaceRepo ? { huggingfaceRepo: block.huggingfaceRepo } : {}),
    ...(block.filename ? { weightsFilename: block.filename } : {}),
    ...(block.draftModel?.filename ? { draftFilename: block.draftModel.filename } : {}),
  };
}

/** Test-only: drop the cached index so a test can rebuild it on disk first. */
export function _resetSourceIndexCache(): void {
  indexCache = null;
}

/**
 * The sources a chat-model ships, or `undefined` when the id isn't in the
 * catalog index (a cloud/CLI model id, or an index that hasn't been built).
 */
export function chatModelSources(modelId: string): ChatModelSources | undefined {
  const id = normalizeChatModelCatalogId(modelId) ?? modelId;
  return loadIndex().get(id)?.sources;
}

function sourceKeyFor(p: ChatProvider): keyof ChatModelSources | null {
  if (p === 'llama-cpp') return 'llamaCpp';
  if (p === 'mlx') return 'mlx';
  if (p === 'ds4') return 'ds4';
  return null;
}

/**
 * Throw a clear, actionable error when a *local-engine* provider is asked to
 * run a model that ships no weights for that engine. No-op for cloud / CLI
 * providers (no catalog source to check) and for unknown model ids (let warm
 * surface its own error). Call right after the effective provider + model id
 * are resolved, before warm.
 */
export function assertLocalEngineSource(provider: ChatProvider, modelId: string): void {
  if (!isLocalEngine(provider)) return;
  const key = sourceKeyFor(provider);
  if (!key) return;
  const sources = chatModelSources(modelId);
  if (!sources) return;
  if (sources[key]) return;

  const alt = sources.ds4 ? 'ds4' : sources.llamaCpp ? 'llama-cpp' : sources.mlx ? 'mlx' : null;
  const have = (['llamaCpp', 'mlx', 'ds4', 'ollama'] as const).filter((k) => sources[k]);
  const hint = alt
    ? ` It ships ${have.join(' + ')}; re-run with --provider ${alt}.`
    : ` It declares no local-engine source (${have.join(', ') || 'none'}).`;
  throw new Error(`Model "${modelId}" has no ${key} weights for --provider ${provider}.${hint}`);
}
