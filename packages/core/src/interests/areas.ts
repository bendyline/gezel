import { z } from 'zod';

/**
 * Interest areas: what a person says they want help with.
 *
 * The welcome asks while the first model downloads, Settings → General holds
 * the same tray, and every surface that offers work (the welcome's first
 * projects, Make something, New Task, New Project, Knowledge) puts the
 * person's areas first. Ordering only: nothing is ever hidden because of a
 * choice, and the answer never enters a prompt.
 *
 * Ids are stored in config and in gilde manifests, so they never change; the
 * labels are copy and can. A held area has an id (gilde can tag content for
 * it ahead of time) but no key until it has work behind it: two first
 * projects that pass their evals and a shelf of real books or types.
 */
export const InterestAreaIdSchema = z.enum([
  'software',
  'data',
  'work',
  'business',
  'content',
  'home',
  'learning',
  'play',
  'health',
  'legal',
]);
export type InterestAreaId = z.infer<typeof InterestAreaIdSchema>;

export interface InterestArea {
  id: InterestAreaId;
  /** The key's words. */
  label: string;
  /** One line under the key. */
  hint: string;
  /** Held areas have no key yet. */
  shipped: boolean;
}

export const INTEREST_AREAS: readonly InterestArea[] = [
  {
    id: 'software',
    label: 'Writing software',
    hint: 'Review, fix, document and ship code',
    shipped: true,
  },
  {
    id: 'data',
    label: 'Data and spreadsheets',
    hint: 'Clean a sheet, chart it, find what changed',
    shipped: true,
  },
  {
    id: 'work',
    label: 'Organization planning',
    hint: 'Notes to actions, status reports, research, decks',
    shipped: true,
  },
  {
    id: 'business',
    label: 'A small business',
    hint: 'Invoices, clients, proposals, marketing copy',
    shipped: true,
  },
  {
    id: 'content',
    label: 'Making content',
    hint: 'Posts, newsletters, video, images, stories',
    shipped: true,
  },
  {
    id: 'home',
    label: 'Home and family',
    hint: 'Trips, photos, meals, the household, celebrations',
    shipped: true,
  },
  {
    id: 'learning',
    label: 'Learning and growth',
    hint: 'A language, a skill, an exam, a career move',
    shipped: true,
  },
  {
    id: 'play',
    label: 'Games and play',
    hint: 'A game against a patient opponent, word puzzles',
    shipped: true,
  },
  {
    id: 'health',
    label: 'Health and caregiving',
    hint: 'Records, medications and appointments',
    shipped: false,
  },
  {
    id: 'legal',
    label: 'Contracts and paperwork',
    hint: 'Contracts, documents and renewals',
    shipped: false,
  },
];

const KNOWN = new Set<string>(InterestAreaIdSchema.options);
const SHIPPED = new Set<string>(INTEREST_AREAS.filter((a) => a.shipped).map((a) => a.id));

export function isInterestAreaId(value: unknown): value is InterestAreaId {
  return typeof value === 'string' && KNOWN.has(value);
}

/** The areas with a key today, in tray order. */
export function shippedInterestAreas(): InterestArea[] {
  return INTEREST_AREAS.filter((a) => a.shipped);
}

export function interestArea(id: InterestAreaId): InterestArea {
  return INTEREST_AREAS.find((a) => a.id === id)!;
}

/**
 * The stored choice, as the surfaces should read it: known, shipped ids in the
 * order the person picked them, once each. Config keeps raw strings so a build
 * that does not know an id (an older app reading a newer config) leaves it in
 * place rather than dropping it on the next save.
 */
export function resolveInterestAreas(
  config: { interests?: { areas?: readonly string[] } } | null | undefined,
): InterestAreaId[] {
  const out: InterestAreaId[] = [];
  for (const raw of config?.interests?.areas ?? []) {
    if (SHIPPED.has(raw) && !out.includes(raw as InterestAreaId)) out.push(raw as InterestAreaId);
  }
  return out;
}

/**
 * The areas to store when the person picks `chosen`: their picks, then every
 * stored id this build cannot show (a held area, or one a newer build added),
 * so a save here never erases what a newer build recorded.
 */
export function interestAreasToSave(
  config: { interests?: { areas?: readonly string[] } } | null | undefined,
  chosen: readonly InterestAreaId[],
): string[] {
  const out: string[] = [];
  for (const id of chosen) if (SHIPPED.has(id) && !out.includes(id)) out.push(id);
  for (const raw of config?.interests?.areas ?? []) {
    if (!SHIPPED.has(raw) && !out.includes(raw)) out.push(raw);
  }
  return out;
}

/** True once the person answered or skipped the question, so it is never asked twice. */
export function interestsAsked(
  config: { interests?: { askedAt?: string } } | null | undefined,
): boolean {
  return typeof config?.interests?.askedAt === 'string';
}

/** How long after first use the welcome may still ask. */
export const INTEREST_QUESTION_WINDOW_MS = 7 * 24 * 60 * 60_000;

/**
 * Whether the welcome asks what the person wants help with: a new install
 * (its `firstUseAt` within a week) that has not answered or skipped yet. An
 * established install carries no `firstUseAt` and is never interrupted to
 * ask; Settings → General holds the same tray.
 */
export function shouldAskInterests(
  config: { interests?: { askedAt?: string }; firstUseAt?: string } | null | undefined,
  nowMs: number,
): boolean {
  if (!config || interestsAsked(config) || !config.firstUseAt) return false;
  const started = Date.parse(config.firstUseAt);
  return Number.isFinite(started) && nowMs - started < INTEREST_QUESTION_WINDOW_MS;
}
