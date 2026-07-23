import type { Store } from '../fs/store.js';
import { sha256 } from './hash.js';

/**
 * Per-file-kind health rubrics for the boekwachter review pass. Rubric
 * presence drives eligibility: a file kind (classify.ts `kind`) with no
 * resolved rubric is never reviewed. Built-ins ship for code / markdown /
 * doc / config; `~/.gezel/rubrics/<kind>.md` replaces a built-in or ADDS a
 * kind (e.g. `text.md` enables reviews for plain-text files).
 *
 * The rubric hash folds in REVIEW_PROMPT_VERSION and is stamped on every
 * review row, so editing a rubric — or bumping the version when the prompt
 * scaffold changes — lazily re-reviews affected files on later sweeps. No
 * eager invalidation, no writes at edit time.
 */

/** Bump when buildReviewPrompt's scaffold changes enough to warrant re-review. */
export const REVIEW_PROMPT_VERSION = 1;

export interface ResolvedRubric {
  kind: string;
  text: string;
  hash: string;
  source: 'builtin' | 'override';
}

/** The Store surface resolveRubrics needs. Partial: several index-store tests
 *  run ContentIndex against minimal Store fakes (workspace-dir only) — a
 *  missing method degrades to built-in rubrics, never throws. */
export type RubricStore = Partial<Pick<Store, 'listIndexRubrics' | 'readConfig'>>;

export const BUILTIN_RUBRICS: Readonly<Record<string, string>> = {
  code: [
    'Health rubric for source code (1-10):',
    '- 9-10: exemplary — single clear responsibility, readable top to bottom, robust error handling, nothing you would flag in review.',
    '- 7-8: solid — cohesive and readable; only minor nits.',
    '- 5-6: ordinary working code — some smells, unclear spots, or missing edge-case handling; nothing dangerous.',
    '- 3-4: shaky — likely bugs, ignored errors, heavy duplication, or misleading structure.',
    '- 1-2: broken or hazardous — syntax errors, plainly wrong logic, or security-sensitive mistakes.',
    'Weigh correctness first, then clarity, then structure. Do not punish length alone.',
  ].join('\n'),
  markdown: [
    'Health rubric for markdown documents (1-10):',
    '- 9-10: publication quality — clear, well-organized, correct grammar, accurate and current.',
    '- 7-8: good — minor wording or formatting nits only.',
    '- 5-6: serviceable — understandable but with clarity, grammar, or structure problems.',
    '- 3-4: rough — hard to follow, error-ridden, or visibly outdated.',
    '- 1-2: broken — incoherent, mostly placeholder, or badly malformed.',
  ].join('\n'),
  doc: [
    'Health rubric for documents (1-10). Judge the substance of the document, not conversion artifacts:',
    '- 9-10: publication quality — clear, well-organized, correct grammar, accurate and current.',
    '- 7-8: good — minor wording or formatting nits only.',
    '- 5-6: serviceable — understandable but with clarity, grammar, or structure problems.',
    '- 3-4: rough — hard to follow, error-ridden, or visibly outdated.',
    '- 1-2: broken — incoherent, mostly placeholder, or badly malformed.',
  ].join('\n'),
  config: [
    'Health rubric for configuration files (1-10):',
    '- 9-10: clean, internally consistent, safe defaults, no secrets.',
    '- 7-8: consistent with minor untidiness.',
    '- 5-6: works but has redundancy, unclear keys, or questionable values.',
    '- 3-4: contradictory or risky settings.',
    '- 1-2: malformed, or contains plaintext credentials.',
  ].join('\n'),
};

function rubricHash(text: string): string {
  return sha256(`v${REVIEW_PROMPT_VERSION}\n${text}`);
}

/**
 * The active rubric per file kind: built-ins, overlaid by user override
 * files, minus `config.fileReviews.disabledKinds`. Empty map (reviews off)
 * when `fileReviews.enabled === false` or `GEZEL_FILE_REVIEWS=0`. All Store
 * reads are guarded so a half-mocked Store in tests degrades to built-ins.
 */
export async function resolveRubrics(store: RubricStore): Promise<Map<string, ResolvedRubric>> {
  if (process.env.GEZEL_FILE_REVIEWS === '0') return new Map();
  let cfg: Awaited<ReturnType<NonNullable<RubricStore['readConfig']>>> | null = null;
  try {
    cfg = (await store.readConfig?.()) ?? null;
  } catch {
    cfg = null;
  }
  if (cfg?.fileReviews?.enabled === false) return new Map();

  const out = new Map<string, ResolvedRubric>();
  for (const [kind, text] of Object.entries(BUILTIN_RUBRICS)) {
    out.set(kind, { kind, text, hash: rubricHash(text), source: 'builtin' });
  }
  let overrides: Record<string, string> = {};
  try {
    overrides = (await store.listIndexRubrics?.()) ?? {};
  } catch {
    overrides = {};
  }
  for (const [kind, raw] of Object.entries(overrides)) {
    const text = raw.trim();
    if (!text) continue;
    out.set(kind, { kind, text, hash: rubricHash(text), source: 'override' });
  }
  for (const kind of cfg?.fileReviews?.disabledKinds ?? []) out.delete(kind);
  return out;
}
