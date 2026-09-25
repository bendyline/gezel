import type { PortableCatalogModel } from '../../core/src/runtime/content.js';
import type { CatalogItemSummary } from '../../core/src/schemas/catalog.js';
import { MobileModelSourceIdentitySchema } from '../../core/src/schemas/mobile-provider.js';

/** Project recipes and model provenance both come from the pinned Gilde snapshot. */
export function portableCatalogModels(items: CatalogItemSummary[]): PortableCatalogModel[] {
  return items
    .flatMap(({ manifest, sourceId }) => {
      if (manifest.kind !== 'chat-model' || !manifest.llamaCpp) return [];
      const source = manifest.llamaCpp;
      if (source.shards || source.approxSizeBytes > 4 * 1024 * 1024 * 1024) return [];
      const identity = MobileModelSourceIdentitySchema.safeParse({
        catalogId: manifest.id,
        catalogVersion: manifest.version,
        sourceId,
        huggingfaceRepo: source.huggingfaceRepo,
        revision: source.revision,
        filename: source.filename,
        sha256: source.sha256,
      });
      if (!identity.success) return [];
      return [
        {
          name: manifest.name,
          description: manifest.description,
          license: manifest.license,
          approxSizeBytes: source.approxSizeBytes,
          contextWindow: manifest.contextWindow,
          source: identity.data,
        },
      ];
    })
    .sort((a, b) => a.approxSizeBytes - b.approxSizeBytes || a.name.localeCompare(b.name));
}
