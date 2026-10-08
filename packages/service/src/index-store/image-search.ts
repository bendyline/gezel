import type { FindSimilarImagesResponse, SearchImagesResponse } from '@bendyline/gezel';
import { resolveKnowledgeVectorFloors } from '../knowledge/vector-floors.js';
import { MEDIA_SEARCH_PROFILE } from '../media-search/profile.js';
import type { MediaVectorModality } from './index-store-types.js';
import type { IndexStore } from './index-store.js';

/**
 * Media search over the vectors and captions already in the index: meaning
 * plus filename search across images and audio/video windows, and visual
 * lookalikes for one image.
 */

/** Reciprocal-rank constant for the media search arms (the knowledge arm uses the same). */
const MEDIA_RRF_K = 60;

export interface SearchImagesOpts {
  kinds?: readonly MediaVectorModality[];
  vector?: number[] | null;
  /** Meaning only: unified search already matches filenames in its file arm. */
  vectorOnly?: boolean;
}

/**
 * Find workspace media by meaning and by name. The vector arm embeds the
 * query with the media-search profile's text model (local files only; no
 * model → keyword search alone) and scores every stored image, or audio and
 * video window, exactly; a hit counts only above its modality's measured
 * floor. The FTS arm matches filenames and captions/transcripts. The two
 * fuse by reciprocal rank, keyed per file and window.
 */
export async function searchIndexedMedia(
  index: IndexStore,
  query: string,
  maxResults: number,
  opts: SearchImagesOpts,
): Promise<SearchImagesResponse> {
  const kinds = opts.kinds?.length ? opts.kinds : (['image'] as const);
  type Hit = SearchImagesResponse['results'][number];
  const fused = new Map<string, { hit: Hit; score: number }>();
  const add = (key: string, hit: Hit, weight: number, rank: number): void => {
    const entry = fused.get(key) ?? { hit, score: 0 };
    entry.score += weight / (MEDIA_RRF_K + rank);
    if (hit.score > entry.hit.score) entry.hit = { ...entry.hit, ...hit };
    fused.set(key, entry);
  };
  const describe = (path: string, kind: MediaVectorModality): Hit => {
    const f = index.getFile(path);
    const md = index.getMetadata(path);
    const summary = f?.hash ? index.getSummary(f.hash) : undefined;
    return {
      path,
      ...(kind !== 'image' ? { kind } : {}),
      ...(md.width ? { width: Number(md.width) } : {}),
      ...(md.height ? { height: Number(md.height) } : {}),
      ...(md.format ? { format: md.format } : {}),
      ...(summary ? { caption: summary } : {}),
      score: 0.5,
    };
  };

  let vectorHits = 0;
  // A file's best-matching window: a filename hit on the same file joins
  // it rather than listing the file a second time without a moment.
  const bestKeyByPath = new Map<string, string>();
  const vector = opts.vector === undefined ? await mediaQueryVector(query) : opts.vector;
  if (vector) {
    const floors = resolveKnowledgeVectorFloors();
    const query32 = Float32Array.from(vector);
    const scored = index
      .allMediaVectors(kinds)
      .filter((row) => row.vec.length === vector.length)
      .map((row) => ({ row, cosine: cosine(query32, row.vec) }))
      .filter(({ row, cosine: c }) => {
        const floor = floors.floorFor({
          catalogKey: 'workspace',
          profileId: MEDIA_SEARCH_PROFILE.id,
          modality: row.modality,
        });
        return floor !== null && c >= floor;
      })
      .sort((a, b) => b.cosine - a.cosine);
    scored.slice(0, maxResults * 2).forEach(({ row, cosine: c }, rank) => {
      const windowed = row.modality !== 'image';
      const key = `${row.filePath}\u0000${windowed ? row.startMs : ''}`;
      if (!bestKeyByPath.has(row.filePath)) bestKeyByPath.set(row.filePath, key);
      add(
        key,
        {
          ...describe(row.filePath, row.modality),
          score: c,
          ...(windowed ? { startMs: row.startMs } : {}),
          ...(windowed && row.endMs !== null ? { endMs: row.endMs } : {}),
        },
        1,
        rank,
      );
      vectorHits++;
    });
  }

  let ftsHits = 0;
  if (index.ftsAvailable && !opts.vectorOnly) {
    // Over-fetch from the shared doc FTS, then keep only the asked-for media.
    let rank = 0;
    for (const h of index.searchDocs(query, maxResults * 4)) {
      const f = index.getFile(h.filePath);
      const kind = f?.modality as MediaVectorModality | undefined;
      if (!kind || !kinds.includes(kind)) continue;
      add(
        bestKeyByPath.get(h.filePath) ?? `${h.filePath}\u0000`,
        describe(h.filePath, kind),
        0.5,
        rank++,
      );
      ftsHits++;
      if (rank > maxResults * 2) break;
    }
  }
  if (vectorHits === 0 && ftsHits === 0) {
    const engine = vector || index.ftsAvailable ? (vector ? 'vector' : 'fts') : 'unavailable';
    return { results: [], engine, truncated: false };
  }
  const ordered = [...fused.values()].sort((a, b) => b.score - a.score).map((e) => e.hit);
  const engine = vectorHits > 0 ? (ftsHits > 0 ? 'hybrid' : 'vector') : 'fts';
  return {
    results: ordered.slice(0, maxResults),
    engine,
    truncated: ordered.length > maxResults,
  };
}

export function findSimilarIndexedImages(
  index: IndexStore,
  relPath: string,
  maxResults: number,
): FindSimilarImagesResponse {
  const hash = index.getFile(relPath)?.hash;
  const target = hash ? index.imageVectorByHash(hash) : null;
  // Mid-migration remnants with a different dim can't be compared.
  const all = target
    ? index.allImageVectors().filter((v) => v.vec.length === target.vec.length)
    : [];
  if (!target || all.length <= 1) {
    // No image embeddings yet (the embed tier hasn't reached this file, or
    // no embedder is available) → can't do visual similarity. Degrades
    // honestly.
    return { results: [], engine: 'unavailable', truncated: false };
  }
  const scored = all
    .filter((v) => v.filePath !== relPath)
    .map((v) => ({ path: v.filePath, score: cosine(target.vec, v.vec) }))
    .sort((a, b) => b.score - a.score);
  const truncated = scored.length > maxResults;
  return { results: scored.slice(0, maxResults), engine: 'vector', truncated };
}

/**
 * The media-search profile's query vector, or null when its model is not
 * installed (local files only — a search never starts a download) or fails.
 */
async function mediaQueryVector(query: string): Promise<number[] | null> {
  try {
    const { embedKnowledgeQuery } = await import('../memory/embeddings.js');
    return await embedKnowledgeQuery(query, MEDIA_SEARCH_PROFILE, { localFilesOnly: true });
  } catch {
    return null;
  }
}

/** Cosine similarity between two equal-length vectors. */
function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}
