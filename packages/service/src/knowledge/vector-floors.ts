import { createLogger } from '@bendyline/gezel';

const log = createLogger('knowledge');

/**
 * Cosine floors for knowledge-catalog vector hits.
 *
 * KNN has no notion of "no good answer": the nearest chunk comes back however
 * far away it is, and the fused rank then scores it 1.0. A floor is what lets
 * the vector arm say nothing. The project index learned this first
 * (`VECTOR_ARM_MIN_SIMILARITY`); these are the same idea for catalogs.
 *
 * Keys are a catalog (`publisher/catalog`) or an embedding profile id; a
 * catalog's own entry wins. A floor is a property of the embedder AND the
 * corpus: multilingual-e5 scores unrelated text higher than bge-small scores
 * a match, and bge-small's genuine matches sit at 0.57 in the project library
 * but 0.69 in the Handboek. So the profile entries are defaults for catalogs
 * nobody measured, and a catalog whose scale is known gets its own.
 *
 * A vector hit under its floor is not evidence: it neither ranks the document
 * nor labels it `vector`. A profile with no floor at all keeps its hits for
 * ranking but labels them `fts`, so proactive injection asks them to be
 * grounded in a query term — an unmeasured scale is not trusted to vouch.
 *
 * Measured with the retrieval preview's `similarity` trace field; method and
 * numbers in evals/src/retrieval-bench/KNOWLEDGE-CALIBRATION-2026-09-30.md.
 * Re-measure on any profile or catalog change: these numbers do not travel.
 */
export const KNOWLEDGE_VECTOR_FLOORS: Readonly<Record<string, number>> = {
  // Handboek 1.1.2: answers ≥ 0.687, off-topic ≤ 0.624.
  'bendyline/handboek': 0.65,
  // The project index's measured floor for the daemon's own embedder
  // (index-store VECTOR_ARM_MIN_SIMILARITY) — what a folder-built catalog gets.
  'bge-small-en-v1.5@1': 0.55,
  // Wikipedia Food & Drink 2026.4.3: answers ≥ 0.869; the scale is compressed
  // and 2 of 25 off-topic prompts still reach it, so grounding and the
  // relevance model do the rest.
  'multilingual-e5-small@2': 0.865,
  // Revision 1 has the same model, instructions and int8 vectors — only its
  // stage-1 sign bits differ — so its rerank cosine is on the same scale.
  'multilingual-e5-small@1': 0.865,
  // Handboek 1.2.2 + a Food & Drink sample re-embedded in this profile (the
  // labelled calibration queries): answers ≥ 0.762 in both, off-topic ≤ 0.706,
  // a query's best chunk in the OTHER catalog ≤ 0.715. A wide gap; the scale
  // is far less compressed than e5's.
  'embeddinggemma-2-512@1': 0.735,
  // Media rows of the same profile, workspace and catalogs alike
  // (evals/src/retrieval-bench/MEDIA-BENCH-2026-10-07.md). Each sits a step
  // above the lowest floor no off-topic prompt reached on the bench corpus,
  // because a real library is larger and its off-topic maximum higher.
  // COCO photos: no off-topic hit from 0.66; 293 of 300 answers keep their photo.
  'embeddinggemma-2-512@1#image': 0.67,
  // MSR-VTT clips: no off-topic hit from 0.65; 54 of 60 answers clear 0.65 and 0.66.
  'embeddinggemma-2-512@1#video': 0.66,
  // ESC-50 sounds: scores bunch (a wrong clip clears 0.66 for most queries),
  // so the floor does less here than ranking; 47 of 50 answers clear 0.68.
  'embeddinggemma-2-512@1#audio': 0.68,
};

export interface KnowledgeVectorFloors {
  /**
   * The floor for a catalog, or null when its scale was never measured. With
   * a `modality`, the floor for that kind of media row (`<key>#image`, …):
   * a text query sits further from a matching image than from a matching
   * passage, so media rows need their own scale.
   */
  floorFor(catalog: {
    catalogKey: string;
    profileId: string;
    modality?: 'image' | 'video' | 'audio';
  }): number | null;
}

const warnedUnmeasured = new Set<string>();

/**
 * `GEZEL_KNOWLEDGE_VECTOR_FLOORS` overrides for calibration: `off` treats
 * every catalog as measured with floor 0, and `key=0.6,key2=0.8` replaces the
 * named entries (catalog or profile keys).
 */
export function resolveKnowledgeVectorFloors(
  env: NodeJS.ProcessEnv = process.env,
): KnowledgeVectorFloors {
  const raw = env.GEZEL_KNOWLEDGE_VECTOR_FLOORS?.trim();
  if (raw === 'off') return { floorFor: () => 0 };
  const floors = new Map(Object.entries(KNOWLEDGE_VECTOR_FLOORS));
  for (const pair of raw ? raw.split(',') : []) {
    const at = pair.lastIndexOf('=');
    const value = Number(pair.slice(at + 1));
    if (at <= 0 || !Number.isFinite(value)) {
      log.warn(`ignoring GEZEL_KNOWLEDGE_VECTOR_FLOORS entry ${JSON.stringify(pair)}`);
      continue;
    }
    floors.set(pair.slice(0, at).trim(), value);
  }
  return {
    floorFor({ catalogKey, profileId, modality }) {
      if (modality) {
        return (
          floors.get(`${catalogKey}#${modality}`) ?? floors.get(`${profileId}#${modality}`) ?? null
        );
      }
      const floor = floors.get(catalogKey) ?? floors.get(profileId);
      if (floor !== undefined) return floor;
      if (!warnedUnmeasured.has(profileId)) {
        warnedUnmeasured.add(profileId);
        log.info(
          `no measured vector floor for embedding profile ${profileId}; its semantic hits must be grounded to be injected`,
        );
      }
      return null;
    },
  };
}
