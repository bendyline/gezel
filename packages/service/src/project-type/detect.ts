import { PROJECT_TYPES, type ProjectType } from '@bendyline/gezel';
import type { Store } from '../fs/store.js';
import type { ContentIndex } from '../index-store/content-index.js';

/**
 * Project-type auto-detection. Scores the bundled taxonomy against a
 * project's indexed file mix (extension + modality histograms) and its
 * about/mission text, returning the candidates ranked best-first. Purely
 * deterministic — no model, no I/O in the scorer itself (the `detectProjectType`
 * wrapper does the I/O and hands a plain `DetectInput` to `scoreProjectTypes`,
 * which keeps the scorer unit-testable).
 */

export interface ProjectTypeScore {
  id: string;
  score: number;
}

export interface LanguageProfile {
  fileCount: number;
  extensions: Record<string, number>;
  modalities: Record<string, number>;
}

export interface DetectInput {
  /** File-shape histogram from the content index; null when not yet indexed. */
  profile: LanguageProfile | null;
  /** Combined about.md + missionObjectives.md text (may be empty). */
  aboutText: string;
}

// Files carry the type's shape; keywords carry its intent. Both ts/js and
// html/css are shared across many types, so the keyword half does most of the
// disambiguating — hence the heavier weight.
const W_FILE = 0.4;
const W_KEYWORD = 0.6;
// A keyword signal saturates at this many distinct hits.
const KEYWORD_SATURATION = 3;

/**
 * Minimum top score before a detection is persisted/trusted. With the
 * weighting above, a pure extension match tops out at `W_FILE` (0.4) and a
 * single keyword hit contributes `W_KEYWORD / KEYWORD_SATURATION` (0.2), so
 * this floor accepts "strong file shape OR ≥1 on-topic keyword" while
 * rejecting noise.
 */
export const PROJECT_TYPE_MIN_SCORE = 0.2;

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countKeywordHits(keywords: string[] | undefined, haystack: string): number {
  if (!keywords?.length || !haystack) return 0;
  let hits = 0;
  for (const kw of keywords) {
    const re = new RegExp(`\\b${escapeRegExp(kw.toLowerCase())}\\b`);
    if (re.test(haystack)) hits++;
  }
  return hits;
}

function fileSignal(type: ProjectType, profile: LanguageProfile | null): number {
  if (!profile || profile.fileCount <= 0) return 0;
  const sumOver = (keys: string[] | undefined, hist: Record<string, number>): number =>
    (keys ?? []).reduce((acc, k) => acc + (hist[k.toLowerCase()] ?? 0), 0);
  const extProp = sumOver(type.detect.extensions, profile.extensions) / profile.fileCount;
  const modProp = sumOver(type.detect.modalities, profile.modalities) / profile.fileCount;
  return clamp01(Math.max(extProp, modProp));
}

/**
 * Score every taxonomy entry against the input, returning a ranked list
 * (highest first, then id-ascending for stability). Zero-score entries are
 * dropped. Pure.
 */
export function scoreProjectTypes(
  input: DetectInput,
  types: ProjectType[] = PROJECT_TYPES,
): ProjectTypeScore[] {
  const haystack = input.aboutText.toLowerCase();
  const scored = types.map((t) => {
    const file = fileSignal(t, input.profile);
    const keyword = clamp01(countKeywordHits(t.detect.keywords, haystack) / KEYWORD_SATURATION);
    return { id: t.id, score: W_FILE * file + W_KEYWORD * keyword };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.id.localeCompare(b.id)));
}

/** Read about.md + missionObjectives.md, concatenated; '' on any miss. */
async function readAboutText(store: Store, projectId: string): Promise<string> {
  const [about, mission] = await Promise.all([
    store.readProjectDoc(projectId, 'about.md').catch(() => ''),
    store.readProjectDoc(projectId, 'missionObjectives.md').catch(() => ''),
  ]);
  return [about, mission].filter(Boolean).join('\n');
}

/**
 * Detect a project's type from its index + about text. Best-effort: any I/O
 * failure degrades to whichever signal is available (or an empty ranking).
 */
export async function detectProjectType(
  deps: { store: Store; contentIndex: ContentIndex },
  projectId: string,
): Promise<ProjectTypeScore[]> {
  const profile = await deps.contentIndex.languageProfile(projectId).catch(() => null);
  const aboutText = await readAboutText(deps.store, projectId);
  return scoreProjectTypes({ profile, aboutText });
}
