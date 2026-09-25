import { roleSuggestedTuningProfile } from '../roles/index.js';
import type { CatalogItemDetail, CatalogItemSummary } from '../schemas/catalog.js';
import { type GezelFrontmatter, GezelFrontmatterSchema } from '../schemas/gezel.js';
import { MATCH_THRESHOLD, type MatchCandidate, rankCandidates } from './match.js';

export interface GildeTemplateResolution {
  templateId: string;
  templateVersion: string;
  role: string;
  /** Template about.md — empty only for fixed-function templates. */
  about: string;
  frontmatter: Partial<GezelFrontmatter> | null;
  nameSuggestions?: readonly string[];
  matchScore: number;
}

/**
 * Score the gilde template roster against a free-form role/job-title and
 * return the best confident match with everything needed to create a
 * gezel from it. Shared by `ensureGezel` (step 2) and the create route's
 * about-omitted fallback, so "a Developer created without an about gets
 * the shipped Developer template" holds on every creation path.
 *
 * Returns null when no template clears `MATCH_THRESHOLD`, or when the
 * matched template's about failed to load (an empty system prompt is
 * worse than the caller's bespoke/placeholder fallback — wild-caught
 *a recruited worker ran a whole eval trial with about='').
 * Fixed-function templates are exempt from the about requirement: they
 * have no LLM behind them.
 */
export async function resolveGezelTemplateForRole(
  catalog: {
    list(): Promise<CatalogItemSummary[]>;
    get(id: string): Promise<CatalogItemDetail | null>;
  },
  jobTitle: string,
): Promise<GildeTemplateResolution | null> {
  const query = jobTitle.trim();
  if (!query) return null;
  const gildeItems = await catalog.list();
  const gildeCandidates: MatchCandidate[] = gildeItems
    .filter((g) => g.manifest.kind === 'gezel-template')
    .map((g) => {
      const m = g.manifest as Extract<typeof g.manifest, { kind: 'gezel-template' }>;
      return {
        id: m.id,
        role: m.role,
        name: m.name,
        tags: m.tags,
        description: m.description,
      };
    });
  const ranked = rankCandidates(query, gildeCandidates);
  const best = ranked[0];
  if (!best || best.score < MATCH_THRESHOLD) return null;
  const detail = await catalog.get(best.id);
  if (!detail || detail.manifest.kind !== 'gezel-template') return null;
  const manifest = detail.manifest;
  const parsedFrontmatter = parseTemplateFrontmatter(manifest.frontmatter);
  // The role registry is the source of truth for role → tuning profile:
  // when a template doesn't pin one, fall back to the canonical role
  // default so the gezel still hydrates a sensible sampling preset at
  // request time (resolveTuning reads frontmatter.suggestedTuningProfile).
  const registryProfile = roleSuggestedTuningProfile(manifest.role);
  const frontmatter: Partial<GezelFrontmatter> | null =
    registryProfile && !parsedFrontmatter?.suggestedTuningProfile
      ? { ...(parsedFrontmatter ?? {}), suggestedTuningProfile: registryProfile }
      : parsedFrontmatter;
  const about = detail.about ?? '';
  const isFixedFunction = Boolean(frontmatter?.fixedFunction);
  if (about.trim().length === 0 && !isFixedFunction) return null;
  return {
    templateId: best.id,
    templateVersion: manifest.version,
    role: manifest.role,
    about,
    frontmatter,
    ...(manifest.nameSuggestions ? { nameSuggestions: manifest.nameSuggestions } : {}),
    matchScore: best.score,
  };
}

function parseTemplateFrontmatter(
  raw: Record<string, unknown> | undefined,
): Partial<GezelFrontmatter> | null {
  if (!raw || Object.keys(raw).length === 0) return null;
  // The schema requires `name`; templates only carry the *extra*
  // frontmatter to merge, so seed a placeholder before parsing and
  // strip it back out. Keeps us on the same validator without
  // forking a "partial" variant.
  const merged = { name: '__template__', ...raw };
  const parsed = GezelFrontmatterSchema.parse(merged);
  const { name: _name, id: _id, ...extras } = parsed;
  return extras;
}
