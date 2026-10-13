import type { CatalogService } from '@bendyline/gezel-catalog';

/**
 * Look up a chat-model manifest's `parameterSize` for the given model
 * id. Best-effort: returns undefined when the model isn't in the
 * catalog (third-party/manual installs) or when the lookup throws.
 *
 * The result feeds `classifyLocalModelTier`, which prefers an explicit
 * parameterSize over tag parsing. The lookup matters because several catalog
 * model tags drop the size suffix — `qwen3.6` is 27B but the tag never says
 * so, and tag-only parsing would land it in `tiny` rather than `medium`.
 */
export async function resolveCatalogParameterSize(
  catalog: CatalogService,
  catalogId: string | undefined,
): Promise<string | undefined> {
  if (!catalogId) return undefined;
  try {
    const detail = await catalog.get('chat-model', catalogId);
    if (!detail) return undefined;
    if (detail.manifest.kind !== 'chat-model') return undefined;
    return detail.manifest.parameterSize;
  } catch {
    return undefined;
  }
}

/**
 * Catalog `contextWindow` lookup, mirroring
 * {@link resolveCatalogParameterSize}. Drives the auto-activation of
 * `prompt.minimal-context`: a model whose window can't hold the standing
 * prompt (e.g. talkie-1930 at 2048) gets the stripped prompt without any
 * per-manifest opt-in. Returns undefined when the id is unknown or the
 * manifest omits the field (treated as "not tiny").
 */
export async function resolveCatalogContextWindow(
  catalog: CatalogService,
  catalogId: string | undefined,
): Promise<number | undefined> {
  if (!catalogId) return undefined;
  try {
    const detail = await catalog.get('chat-model', catalogId);
    if (!detail) return undefined;
    if (detail.manifest.kind !== 'chat-model') return undefined;
    return detail.manifest.contextWindow;
  } catch {
    return undefined;
  }
}
