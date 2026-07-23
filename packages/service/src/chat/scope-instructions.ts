/**
 * Task-scoped slicing of a project's imported AGENTS.md instructions for
 * small local models.
 *
 * Why: a project's `about` carries the full imported AGENTS.md between
 * `<!-- gezel:instructions:start -->` / `…:end -->` markers (written by
 * `workspace/import-sync.ts`). For a large/cloud model that whole guide
 * is a *feature* — the model holds the entire monorepo map, attends to
 * the 5% that matters, and skips exploration round-trips. For a
 * tiny/small/medium local model it's the opposite: an ~8K-token guide
 * covering every package (video export, recorder, jsonForm, 23
 * templates…) dilutes already-thin attention.
 *
 * Wild-caught (gemma4-e4b squisq Geohash bug): a Developer
 * asked to fix `Geohash.ts` never found its footing — it re-read the
 * file across turns and narrated intent without editing. The same task
 * on Claude (which had the full AGENTS.md and could hold all of it)
 * shipped all three bugs in one shot. The differentiator was as much
 * *context* as raw capability: gemma either lacked the map or, once it
 * was imported, drowned in it.
 *
 * This module keeps the orientation + "don't break the build" sections
 * (overview, build/test, install, code style, type-safety conventions)
 * plus the sections whose heading/body overlap the active task, and
 * drops the rest behind a one-line pointer. Large/cloud tiers are never
 * sliced — they get the doc verbatim. When nothing would be dropped the
 * original `about` is returned unchanged so the cache key doesn't churn.
 *
 * Pure + dependency-free so the section ranking is unit-testable in
 * isolation from the prompt builder.
 */

/** Mirrors the markers written by `workspace/import-sync.ts`. */
export const PROJECT_INSTRUCTIONS_START = '<!-- gezel:instructions:start -->';
export const PROJECT_INSTRUCTIONS_END = '<!-- gezel:instructions:end -->';

/** Soft ceiling (chars) for header + kept sections. ~1.5K tokens. */
const DEFAULT_BUDGET_CHARS = 6000;
/** Below this the imported block isn't big enough to be worth slicing. */
const DEFAULT_MIN_BLOCK_CHARS = 3000;
/** Cap on relevance-ranked (non-essential) sections kept. */
const DEFAULT_MAX_SCORED_SECTIONS = 6;

export interface ScopeInstructionsOptions {
  budgetChars?: number;
  minBlockChars?: number;
  maxScoredSections?: number;
}

/**
 * Generic task-management words that carry no scoping signal — they
 * appear in nearly every task title ("Address 3 High-Impact Bugs from
 * Quality Audit Report") and would otherwise rank sections by noise.
 */
const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'this',
  'that',
  'your',
  'our',
  'you',
  'step',
  'task',
  'tasks',
  'bug',
  'bugs',
  'fix',
  'fixes',
  'fixed',
  'issue',
  'issues',
  'address',
  'impact',
  'high',
  'low',
  'quality',
  'audit',
  'report',
  'analyze',
  'analysis',
  'number',
  'first',
  'second',
  'third',
]);

/**
 * Heading patterns whose sections are always kept regardless of task
 * relevance — orientation + the rules that keep a small model from
 * breaking the build. Deliberately excludes "repository structure" /
 * "subpath exports": those are large and *do* get relevance-scored (a
 * file-path task almost always matches the tree, so they survive when
 * useful and drop when they're dead weight).
 */
// Stem-matched (no trailing `\b`) so inflections land: `install` →
// "Installing", `depend` → "Dependencies", `convention` → "Conventions",
// `script` → "Scripts". Leading `\b` still prevents mid-word hits
// ("rebuild" doesn't match `build`).
const ESSENTIAL_HEADING =
  /\b(overview|build|install|depend|test|code\s+style|coding\s+style|type[\s-]?safety|convention|lint|format|getting\s+started|set\s?up|script)/i;

function tokenize(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // split camelCase / PascalCase
    .split(/[^a-zA-Z0-9]+/)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

interface Section {
  headingText: string;
  /** Full chunk including the `## ` heading line. */
  raw: string;
}

/**
 * Split the imported block at every H2 (`## `, not `### `). The leading
 * text plus the FIRST H2 chunk (the "imported from AGENTS.md" wrapper +
 * the doc's H1 title + intro) become the always-kept header; the rest
 * are scoreable sections.
 */
function splitSections(blockInner: string): { header: string; sections: Section[] } {
  const parts = blockInner.split(/(?=^##[ \t][^#])/m);
  // When the block has leading prose before the first H2, `split` emits
  // it as parts[0]; when it begins right at an H2 (the usual import
  // shape) parts[0] IS the first H2 chunk. Detect that so the
  // off-by-one doesn't fold the first real section into the header.
  const hasLeading = parts.length > 0 && !/^##[ \t]/.test(parts[0] ?? '');
  const leading = hasLeading ? (parts[0] ?? '') : '';
  const wrapperIdx = hasLeading ? 1 : 0;
  // Header = any leading prose + the first H2 chunk (the "imported from
  // AGENTS.md" wrapper + the doc's H1 title/intro). Always kept.
  const header = `${leading}${parts[wrapperIdx] ?? ''}`;
  const sections: Section[] = [];
  for (let i = wrapperIdx + 1; i < parts.length; i++) {
    const raw = parts[i]!;
    const headingText = (raw.match(/^##[ \t]+(.+)$/m)?.[1] ?? '').trim();
    sections.push({ headingText, raw });
  }
  if (sections.length === 0) {
    return { header: blockInner, sections: [] };
  }
  return { header, sections };
}

function isEssential(headingText: string): boolean {
  return ESSENTIAL_HEADING.test(headingText);
}

function scoreSection(section: Section, queryTerms: readonly string[]): number {
  if (queryTerms.length === 0) return 0;
  const headingTokens = new Set(tokenize(section.headingText));
  const bodyCounts = new Map<string, number>();
  for (const t of tokenize(section.raw)) bodyCounts.set(t, (bodyCounts.get(t) ?? 0) + 1);
  let score = 0;
  for (const term of queryTerms) {
    if (headingTokens.has(term)) score += 5; // a heading hit is a strong signal
    score += Math.min(bodyCounts.get(term) ?? 0, 3); // cap body weight per term
  }
  return score;
}

export interface ScopeResult {
  scoped: string;
  keptHeadings: string[];
  omittedHeadings: string[];
}

/**
 * Slice one imported-instructions block (the text between the markers)
 * down to header + essentials + the most task-relevant sections.
 * Exported for unit tests; production callers go through
 * {@link scopeProjectAboutForTier}.
 */
export function scopeInstructionsMarkdown(
  blockInner: string,
  queryTerms: readonly string[],
  opts: { budgetChars: number; maxScoredSections: number },
): ScopeResult {
  const { header, sections } = splitSections(blockInner);
  if (sections.length === 0) {
    return { scoped: blockInner, keptHeadings: [], omittedHeadings: [] };
  }

  const essentials = sections.filter((s) => isEssential(s.headingText));
  const scored = sections
    .filter((s) => !isEssential(s.headingText))
    .map((s) => ({ s, score: scoreSection(s, queryTerms) }))
    .sort((a, b) => b.score - a.score);

  const keep = new Set<Section>(essentials);
  let budget = opts.budgetChars - header.length - essentials.reduce((n, s) => n + s.raw.length, 0);

  let scoredKept = 0;
  for (const { s, score } of scored) {
    if (score <= 0 || scoredKept >= opts.maxScoredSections) break; // sorted desc
    // Always allow the single most-relevant section through even if it
    // blows the budget — losing the map is worse than a long prompt.
    const isTopRelevant = scoredKept === 0;
    if (s.raw.length <= budget || isTopRelevant) {
      keep.add(s);
      budget -= s.raw.length;
      scoredKept++;
    }
  }

  // Reassemble in document order.
  const keptHeadings: string[] = [];
  const omittedHeadings: string[] = [];
  let out = header.trimEnd();
  for (const s of sections) {
    if (keep.has(s)) {
      keptHeadings.push(s.headingText);
      out += `\n\n${s.raw.trim()}`;
    } else {
      omittedHeadings.push(s.headingText);
    }
  }
  if (omittedHeadings.length > 0) {
    out += `\n\n_Project-guide sections omitted to keep this prompt focused on the task: ${omittedHeadings
      .map((h) => `“${h}”`)
      .join(', ')}. Ask the voorman or read \`AGENTS.md\` in the workspace if you need one._`;
  }
  return { scoped: out, keptHeadings, omittedHeadings };
}

interface AboutSplit {
  before: string;
  inner: string;
  after: string;
}

function splitAboutInstructions(about: string): AboutSplit | null {
  const start = about.indexOf(PROJECT_INSTRUCTIONS_START);
  if (start === -1) return null;
  const end = about.indexOf(PROJECT_INSTRUCTIONS_END, start + PROJECT_INSTRUCTIONS_START.length);
  if (end === -1) return null;
  return {
    before: about.slice(0, start),
    inner: about.slice(start + PROJECT_INSTRUCTIONS_START.length, end),
    after: about.slice(end + PROJECT_INSTRUCTIONS_END.length),
  };
}

/** Tiers that get the sliced doc; large/cloud (and unknown) get it whole. */
export function tierGetsScopedInstructions(tier: string | undefined): boolean {
  return tier === 'tiny' || tier === 'small' || tier === 'medium';
}

/** Build the relevance query from the active task's title/step/deliverable. */
export function buildScopeQueryTerms(task?: {
  title?: string;
  stepName?: string;
  deliverableFile?: string;
}): string[] {
  if (!task) return [];
  const raw: string[] = [];
  if (task.title) raw.push(task.title);
  if (task.stepName) raw.push(task.stepName);
  if (task.deliverableFile) {
    // Path → tokens: keep dir segments + basename, drop the extension.
    raw.push(task.deliverableFile.replace(/[/\\]/g, ' ').replace(/\.[a-z0-9]+$/i, ''));
  }
  const terms = new Set<string>();
  for (const s of raw) for (const t of tokenize(s)) terms.add(t);
  return [...terms];
}

/**
 * Top-level entry: given a project's `about`, return a task-scoped
 * version for small local models or the original verbatim for
 * large/cloud (and when there's nothing worth slicing).
 */
export function scopeProjectAboutForTier(
  about: string,
  input: {
    tier: string | undefined;
    task?: { title?: string; stepName?: string; deliverableFile?: string };
    options?: ScopeInstructionsOptions;
  },
): string {
  if (!tierGetsScopedInstructions(input.tier)) return about;
  const split = splitAboutInstructions(about);
  if (!split) return about;
  const minBlock = input.options?.minBlockChars ?? DEFAULT_MIN_BLOCK_CHARS;
  if (split.inner.length < minBlock) return about;

  const result = scopeInstructionsMarkdown(split.inner, buildScopeQueryTerms(input.task), {
    budgetChars: input.options?.budgetChars ?? DEFAULT_BUDGET_CHARS,
    maxScoredSections: input.options?.maxScoredSections ?? DEFAULT_MAX_SCORED_SECTIONS,
  });
  // Nothing trimmed — keep the original so the stable-prefix cache key
  // doesn't churn for no benefit.
  if (result.omittedHeadings.length === 0) return about;
  return `${split.before}${PROJECT_INSTRUCTIONS_START}\n${result.scoped.trim()}\n${PROJECT_INSTRUCTIONS_END}${split.after}`;
}
