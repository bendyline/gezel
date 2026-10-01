import type { ModelTier, ProviderName } from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import { type ResolvedModelProfile, resolveProfile } from '@bendyline/gezel/local-loop';

// Resolution moved to core so the portable runtime resolves profiles the same
// way; only the catalog-service lookup lives here.
export * from '@bendyline/gezel/local-loop';

/**
 * Convenience helper for tests + prompt-build sites that need the
 * resolved profile but don't already have a manifest in hand.
 * Looks the manifest up via the catalog service and forwards.
 */
export async function resolveProfileForCatalogId(args: {
  catalog: CatalogService;
  catalogId: string | undefined;
  tier: ModelTier;
  providerName: ProviderName;
}): Promise<ResolvedModelProfile> {
  const { catalog, catalogId, tier, providerName } = args;
  if (!catalogId) {
    return resolveProfile({ manifest: undefined, tier, providerName });
  }
  const detail = await catalog.get('chat-model', catalogId).catch(() => null);
  const manifest = detail?.manifest.kind === 'chat-model' ? detail.manifest : undefined;
  return resolveProfile({ manifest, tier, providerName });
}
