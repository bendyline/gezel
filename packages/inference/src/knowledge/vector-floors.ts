import { createLogger } from '@bendyline/gezel';
import { KNOWLEDGE_VECTOR_FLOORS } from '@bendyline/gezel-knowledge';

const log = createLogger('knowledge');

// The measured floors themselves are the knowledge package's data, shared
// with live indexes that run without this host.
export { KNOWLEDGE_VECTOR_FLOORS };

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
