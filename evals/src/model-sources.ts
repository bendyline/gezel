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

let indexCache: Map<string, ChatModelSources> | null = null;

function loadIndex(): Map<string, ChatModelSources> {
  if (indexCache) return indexCache;
  const path = join(gildeDataDir(), 'chat-models', 'index.json');
  const map = new Map<string, ChatModelSources>();
  try {
    const idx = JSON.parse(readFileSync(path, 'utf8')) as {
      entries?: Array<{
        manifest?: {
          id?: string;
          ollama?: unknown;
          llamaCpp?: unknown;
          mlx?: { disabledReason?: unknown } | unknown;
          ds4?: unknown;
        };
      }>;
    };
    for (const entry of idx.entries ?? []) {
      const man = entry.manifest;
      if (!man?.id) continue;
      // A `disabledReason` on the mlx block marks a known-broken MLX build
      // (e.g. Gemma-4 E4B's mlx-vlm arch gap) — treat it as NO mlx source
      // so `assertLocalEngineSource('mlx', …)` errors clearly with a
      // "use --provider llama-cpp" hint instead of the model appearing
      // MLX-capable and crashing on load.
      const mlxBlock = man.mlx as { disabledReason?: unknown } | undefined;
      map.set(man.id, {
        ollama: Boolean(man.ollama),
        llamaCpp: Boolean(man.llamaCpp),
        mlx: Boolean(man.mlx) && !mlxBlock?.disabledReason,
        ds4: Boolean(man.ds4),
      });
    }
  } catch {
    // No / unreadable index — return an empty map so callers treat every
    // model as "unknown" and defer to downstream warm rather than crash.
  }
  indexCache = map;
  return map;
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
  return loadIndex().get(id);
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
