import { type CraftbookCategory, resolveCraftbookCategory } from '../craftbook-categories.js';
import type { ProjectTypeCategory } from '../schemas/catalog.js';
import type { InterestAreaId } from './areas.js';

/**
 * Which areas a craftbook category serves, absent a book's own `interests`.
 *
 * The category gets most books right. Where it does not, the book says so in
 * gilde: `practice` holds ways of working (plan, build-loop), not learning, so
 * it maps to nothing, and the career books under `business` and the study
 * drills under `personal` carry their own override.
 */
const CATEGORY_AREAS: Record<CraftbookCategory, readonly InterestAreaId[]> = {
  'code-build': ['software'],
  'code-quality': ['software'],
  'code-review': ['software'],
  'code-data': ['software'],
  'code-release': ['software'],
  'code-ops': ['software'],
  'code-docs': ['software'],
  writing: ['work', 'content'],
  media: ['content'],
  design: ['content'],
  marketing: ['business', 'content'],
  research: ['work'],
  business: ['work', 'business'],
  personal: ['home'],
  practice: [],
  other: [],
};

const PROJECT_TYPE_CATEGORY_AREAS: Record<ProjectTypeCategory, readonly InterestAreaId[]> = {
  general: [],
  code: ['software'],
  communication: ['work'],
  creative: ['content'],
  writing: ['content'],
  growth: ['learning'],
  game: ['play'],
  data: ['data'],
  home: ['home'],
  money: ['business', 'home'],
  events: ['home'],
  other: [],
};

/** The areas a craftbook serves: its own `interests`, else its category's. */
export function interestAreasForCraftbook(manifest: {
  interests?: readonly InterestAreaId[];
  category?: CraftbookCategory;
  tags?: readonly string[];
}): readonly InterestAreaId[] {
  if (manifest.interests && manifest.interests.length > 0) return manifest.interests;
  return CATEGORY_AREAS[resolveCraftbookCategory(manifest)];
}

/** The areas a whole project-type category serves, for ordering a gallery's shelves. */
export function interestAreasForProjectTypeCategory(
  category: ProjectTypeCategory,
): readonly InterestAreaId[] {
  return PROJECT_TYPE_CATEGORY_AREAS[category] ?? [];
}

/** The areas a project type serves: its own `interests`, else its category's. */
export function interestAreasForProjectType(manifest: {
  interests?: readonly InterestAreaId[];
  category?: ProjectTypeCategory;
}): readonly InterestAreaId[] {
  if (manifest.interests && manifest.interests.length > 0) return manifest.interests;
  return manifest.category ? PROJECT_TYPE_CATEGORY_AREAS[manifest.category] : [];
}

/**
 * Put what serves the person's areas first, in the order they picked the
 * areas, and keep everything else after it in its original order. Never drops
 * an item: a choice orders what a person sees, it does not decide what exists.
 */
export function orderByInterests<T>(
  items: readonly T[],
  areasOf: (item: T) => readonly InterestAreaId[],
  chosen: readonly InterestAreaId[],
): T[] {
  if (chosen.length === 0) return [...items];
  const rank = (item: T): number => {
    let best = Number.POSITIVE_INFINITY;
    for (const area of areasOf(item)) {
      const at = chosen.indexOf(area);
      if (at !== -1 && at < best) best = at;
    }
    return best;
  };
  return items
    .map((item, index) => ({ item, index, rank: rank(item) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.item);
}

/**
 * The first `count` items in interest order, keeping the range in view: when
 * every one of them serves the chosen areas and something else exists, the
 * last place goes to the first item that does not. A person who picked one
 * area should still see that gezel does other things.
 */
export function pickWithRange<T>(
  items: readonly T[],
  areasOf: (item: T) => readonly InterestAreaId[],
  chosen: readonly InterestAreaId[],
  count: number,
): T[] {
  const ordered = orderByInterests(items, areasOf, chosen);
  const shown = ordered.slice(0, count);
  if (chosen.length === 0 || shown.length < count) return shown;
  const serves = (item: T) => servesInterests(areasOf(item), chosen);
  if (!shown.every(serves)) return shown;
  const other = ordered.find((item) => !serves(item));
  return other ? [...shown.slice(0, count - 1), other] : shown;
}

/** True when the item serves at least one chosen area. */
export function servesInterests(
  areas: readonly InterestAreaId[],
  chosen: readonly InterestAreaId[],
): boolean {
  return areas.some((area) => chosen.includes(area));
}
