/**
 * Resolve a gilde `knowledge-catalog` entry to the hardened URL install the
 * daemon already knows how to run: the pinned commit + path become an
 * immutable Hugging Face resolve URL, and the pinned sha256 becomes the
 * digest the installer must observe. The entry is the trust root, exactly as
 * a chat model's pinned files are — no signature, no registry round trip.
 */

import type {
  KnowledgeCatalogHuggingfaceSource,
  KnowledgeCatalogItemManifest,
} from '@bendyline/gezel';
import type { TrustedKnowledgeCoordinate } from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';

/** Test seam: an e2e run points this at a local server. */
export const HF_BASE_URL_ENV = 'GEZEL_HF_BASE_URL';

export function huggingfaceDatasetResolveUrl(
  source: KnowledgeCatalogHuggingfaceSource,
  baseUrl = process.env[HF_BASE_URL_ENV]?.trim() || 'https://huggingface.co',
): string {
  const path = source.path
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
  return `${baseUrl.replace(/\/$/, '')}/datasets/${source.repo}/resolve/${encodeURIComponent(source.revision)}/${path}?download=true`;
}

export interface ResolvedKnowledgeCatalogSource {
  item: KnowledgeCatalogItemManifest;
  url: string;
  sha256: string;
  archiveBytes: number;
  uncompressedBytes: number;
  coordinate: TrustedKnowledgeCoordinate;
}

export async function resolveKnowledgeCatalogSource(
  catalog: CatalogService,
  id: string,
  version?: string,
): Promise<ResolvedKnowledgeCatalogSource | null> {
  const detail = await catalog.get('knowledge-catalog', id, undefined, version);
  if (!detail || detail.manifest.kind !== 'knowledge-catalog') return null;
  const item = detail.manifest;
  return {
    item,
    url: huggingfaceDatasetResolveUrl(item.huggingface),
    sha256: item.sha256,
    archiveBytes: item.archiveBytes,
    uncompressedBytes: item.uncompressedBytes,
    coordinate: {
      publisherId: item.publisherId,
      catalogId: item.id,
      version: item.version,
      expectedDigest: item.sha256,
    },
  };
}
