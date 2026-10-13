import type { InterestAreaId } from './areas.js';

/** Wikipedia subject catalogs, by the subject in their id (`wikipedia-<subject>`). */
const WIKIPEDIA_SUBJECT_AREAS: Record<string, readonly InterestAreaId[]> = {
  arts: ['content'],
  astronomy: ['learning'],
  biology: ['learning'],
  business: ['work', 'business'],
  'film-tv': ['content'],
  'food-drink': ['home'],
  games: ['play'],
  language: ['learning'],
  law: ['legal'],
  literature: ['content', 'learning'],
  mathematics: ['data', 'learning'],
  medicine: ['health'],
  military: ['learning'],
  music: ['content'],
  politics: ['learning'],
  'religion-philosophy': ['learning'],
  science: ['learning'],
  sports: ['play'],
  technology: ['software', 'learning'],
  transportation: ['learning'],
};

/**
 * The areas a knowledge catalog serves, from its id's family: the catalogs
 * come in a few families with stable prefixes, so a new release in a family
 * is placed without a code change.
 */
export function interestAreasForKnowledgeCatalog(id: string): readonly InterestAreaId[] {
  if (id.startsWith('microsoftdocs-')) return ['software'];
  if (id.startsWith('regional-')) return ['home'];
  if (id.startsWith('caselaw-')) return ['legal'];
  const subject = /^wikipedia-(.+)$/.exec(id)?.[1];
  if (subject) return WIKIPEDIA_SUBJECT_AREAS[subject] ?? ['learning'];
  return [];
}

/**
 * Catalogs about one place (a region's travel guide, one state's case law).
 * Only the person knows which place they need, so they are never suggested;
 * the full list keeps them.
 */
function isPlaceSpecific(id: string): boolean {
  return id.startsWith('regional-') || id.startsWith('caselaw-');
}

/**
 * Knowledge catalogs to offer for the person's areas: up to two per area, in
 * the order the areas were picked, smallest first, never one already on the
 * device. An offer is only an offer: nothing downloads until it is tapped.
 */
export function suggestKnowledgeCatalogs<
  T extends { id: string; archiveBytes: number; installed?: unknown },
>(catalogs: readonly T[], chosen: readonly InterestAreaId[], max = 6): T[] {
  const out: T[] = [];
  for (const area of chosen) {
    const fits = catalogs
      .filter(
        (c) =>
          !c.installed &&
          !isPlaceSpecific(c.id) &&
          !out.includes(c) &&
          interestAreasForKnowledgeCatalog(c.id).includes(area),
      )
      .sort((a, b) => a.archiveBytes - b.archiveBytes)
      .slice(0, 2);
    for (const c of fits) if (out.length < max) out.push(c);
  }
  return out;
}
