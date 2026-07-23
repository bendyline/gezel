import type { IndexStore } from './index-store.js';

/**
 * Meta-boekwachter, deterministic tier (Phase 7): derive cross-file entities
 * from structured metadata that earlier phases already extracted — email
 * senders (`from`), legal parties (`party`), etc. — and record a mention per
 * file. This is the no-model path: it turns the frontmatter the source adapters
 * emit into a queryable who/what graph ("every email from X", "every contract
 * mentioning party Y"). LLM-based NER over prose (people/orgs/topics across code
 * + docs) is the model-dependent extension that plugs into the same tables.
 */

// metadata key → entity kind.
const METADATA_ENTITY_KEYS: Array<[key: string, kind: string]> = [
  ['from', 'person'],
  ['party', 'party'],
];

function extractEmail(value: string): string | null {
  const angled = /<([^>]+@[^>]+)>/.exec(value);
  if (angled) return angled[1]!.toLowerCase();
  const bare = /([^\s<>]+@[^\s<>]+)/.exec(value);
  return bare ? bare[1]!.toLowerCase() : null;
}

export interface EntityBuildResult {
  entities: number;
  mentions: number;
}

/** Rebuild the entity/mention tables for a collection from file metadata. */
export function buildEntitiesFromMetadata(store: IndexStore): EntityBuildResult {
  store.clearEntities();
  const seen = new Set<string>();
  let mentions = 0;
  for (const f of store.allFiles()) {
    const md = store.getMetadata(f.path);
    for (const [key, kind] of METADATA_ENTITY_KEYS) {
      const value = md[key];
      if (!value) continue;
      const canonical = (key === 'from' ? extractEmail(value) : null) ?? value.toLowerCase();
      const id = store.upsertEntity(kind, value, canonical);
      store.addEntityMention(id, f.path);
      mentions++;
      seen.add(`${kind}:${canonical}`);
    }
  }
  return { entities: seen.size, mentions };
}
