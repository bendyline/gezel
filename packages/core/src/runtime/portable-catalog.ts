import type { CatalogItemSummary } from '../schemas/catalog.js';
import { MobileModelSourceIdentitySchema } from '../schemas/mobile-provider.js';
import type { BehaviorEntry } from '../schemas/model-profile.js';
import type { PortableCatalogModel } from './content.js';

/** MLX-only behaviors do nothing under llama.cpp; one embeds a whole chat template. */
function isMlxOnlyBehavior(entry: BehaviorEntry): boolean {
  const id = typeof entry === 'string' ? entry : entry.id;
  return id.startsWith('tools.mlx-');
}

/**
 * The chat models a phone can download, projected from the pinned Gilde
 * snapshot with their provenance and tuning. The phone build bundles this; the
 * eval harness uses it to stage a GGUF as the catalog download it is.
 */
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
          // Phones resolve sampling from this like the desktop does; without
          // it every phone reply was greedy (2026-09-27).
          ...(manifest.tuning ? { tuning: manifest.tuning } : {}),
          ...(manifest.style?.reasoningFormat
            ? { reasoningFormat: manifest.style.reasoningFormat }
            : {}),
          ...(manifest.style ? { style: manifest.style } : {}),
          ...(manifest.behaviors?.length
            ? { behaviors: manifest.behaviors.filter((entry) => !isMlxOnlyBehavior(entry)) }
            : {}),
          parameterSize: manifest.parameterSize,
        },
      ];
    })
    .sort((a, b) => a.approxSizeBytes - b.approxSizeBytes || a.name.localeCompare(b.name));
}
