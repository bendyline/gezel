import { catalogReasoningBudget, normalizeChatModelCatalogId } from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';

/**
 * Translate a possibly-tag-shaped model id to its canonical catalog
 * id. The chat manager stores `record.model` as whatever string the
 * caller passed — which is often the Ollama tag (`gemma4:26b`,
 * `qwen3.6:latest`) rather than the catalog id (`gemma4-26b`,
 * `qwen3.6`). All downstream lookups (parameter size, profile
 * resolution) need the catalog id; without this translation they
 * miss and fall through to tier defaults, which silently disables
 * every per-model behavior the manifest declared.
 *
 * Resolution order:
 *   1. Direct id lookup — `catalog.get('chat-model', modelId)` hits
 *      when the caller passed the canonical id (e.g. `gemma4-26b`).
 *   2. Tag-aware fallback — list every chat-model entry and find
 *      one whose `ollama.tag` matches the requested string (or its
 *      `:latest`-stripped form). Worth the O(n) walk because the
 *      catalog list is small (~12 entries) and the result of step 1
 *      determines whether the per-model behaviors fire at all.
 *
 * Returns `undefined` when neither path resolves — caller falls back
 * to the original modelId string for downstream logic. Best-effort:
 * any thrown error from the catalog returns undefined silently.
 */
export async function resolveCatalogIdFromModelId(
  catalog: CatalogService,
  modelId: string | undefined,
): Promise<string | undefined> {
  if (!modelId) return undefined;
  const normalized = normalizeChatModelCatalogId(modelId);
  try {
    const direct = await catalog.get('chat-model', normalized ?? modelId);
    if (direct && direct.manifest.kind === 'chat-model') return direct.manifest.id;
  } catch {
    // Fall through to the tag-aware path.
  }
  try {
    const baseTag = modelId.replace(/:latest$/, '');
    const items = await catalog.list('chat-model');
    for (const item of items) {
      if (item.manifest.kind !== 'chat-model') continue;
      const tag = item.manifest.ollama?.tag;
      if (tag === modelId || tag === baseTag) return item.manifest.id;
    }
  } catch {
    // Fall through.
  }
  return undefined;
}

/**
 * Catalog-driven `--reasoning-budget N` lookup. Returns the integer
 * the supervisor passes to `llama-server`, or undefined to leave the
 * default unrestricted (-1). The rule itself is shared with the phone's
 * native chat layer: see `catalogReasoningBudget`.
 */
export async function resolveCatalogReasoningBudget(
  catalog: CatalogService,
  catalogId: string | undefined,
): Promise<number | undefined> {
  if (!catalogId) return undefined;
  try {
    const resolvedCatalogId = (await resolveCatalogIdFromModelId(catalog, catalogId)) ?? catalogId;
    const detail = await catalog.get('chat-model', resolvedCatalogId);
    if (!detail || detail.manifest.kind !== 'chat-model') return undefined;
    return catalogReasoningBudget(detail.manifest.tuning);
  } catch {
    return undefined;
  }
}

/**
 * The catalog manifest's per-model llama.cpp engine-launch defaults
 * (`tuning.engine.llamaCpp`), if any. Mirrors
 * {@link resolveCatalogReasoningBudget}: engine flags are a model-LOAD
 * concern (argv), so we read them straight off the manifest rather than
 * the per-request tuning resolver. Returns undefined on any miss — the
 * launcher then falls through to global `config.llamaCpp*` + server
 * defaults.
 */
export async function resolveCatalogLlamaCppEngineConfig(
  catalog: CatalogService,
  catalogId: string | undefined,
) {
  if (!catalogId) return undefined;
  try {
    const resolvedCatalogId = (await resolveCatalogIdFromModelId(catalog, catalogId)) ?? catalogId;
    const detail = await catalog.get('chat-model', resolvedCatalogId);
    if (!detail || detail.manifest.kind !== 'chat-model') return undefined;
    return detail.manifest.tuning?.engine?.llamaCpp;
  } catch {
    return undefined;
  }
}
