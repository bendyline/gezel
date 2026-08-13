import {
  type GezelFrontmatter,
  GezelFrontmatterSchema,
  type GezelGender,
  inferGenderForName,
  pickRandomNameWithGender,
  roleSuggestedTuningProfile,
} from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import { generateGezelAbout } from '../about/generator.js';
import type { ChatManager } from '../chat/manager.js';
import type { Store } from '../fs/store.js';
import { MATCH_THRESHOLD, type MatchCandidate, rankCandidates } from './match.js';

export interface EnsureGezelOptions {
  /** Free-form job title — "designer", "dev", "UX researcher", etc. */
  jobTitle: string;
  /** Caller-supplied first name. Only used when creating. */
  preferredName?: string;
}

export type EnsureGezelAction = 'reused' | 'created-from-gilde' | 'created-bespoke';

export interface EnsureGezelResult {
  gezelId: string;
  name: string;
  role: string;
  action: EnsureGezelAction;
  /** Match score (when reused or matched-to-gilde). */
  matchScore?: number;
  /** Gilde template id when `action === 'created-from-gilde'`. */
  templateId?: string;
  /** Runner-up candidate ids — helps the caller course-correct. */
  alternatives?: string[];
}

/**
 * Resolve a request for "a gezel who can do X" into a concrete gezel.
 * Resolution order:
 *
 *   1. **Reuse**: score the existing roster, pick the best fit above
 *      `MATCH_THRESHOLD`. Prefer a shared gezel even if the asker is
 *      working on a different project — memory of the user's
 *      preferences lives with the gezel, and carrying that across
 *      projects is most of the point.
 *   2. **Gilde**: score the curated template roster (designer,
 *      copywriter, etc.). On a hit, create from that exact template with a
 *      caller-supplied `preferredName` or a random one from the same pool.
 *   3. **Bespoke**: spin up an LLM one-shot to write a real about.md
 *      from `jobTitle`, then create the gezel with it. The name falls
 *      back to the same random pool.
 *
 * Never throws on a zero-score roster — the caller can always fall
 * through to the bespoke path.
 */
export async function ensureGezel(args: {
  opts: EnsureGezelOptions;
  store: Store;
  catalog: CatalogService;
  chat: ChatManager;
  /**
   * Task orchestration must not invoke another model from inside an active
   * model's tool call. Use `static` there; interactive/user-facing creation
   * keeps the authored one-shot fallback.
   */
  bespokeMode?: 'generated' | 'static';
}): Promise<EnsureGezelResult> {
  const { opts, store, catalog, chat, bespokeMode = 'generated' } = args;
  const query = opts.jobTitle.trim();
  if (!query) throw new Error('ensureGezel: jobTitle is required');

  // 1. Reuse: score the existing roster.
  const existing = await store.listGezels();
  const rosterCandidates: MatchCandidate[] = existing.map((g) => ({
    id: g.id,
    role: g.role,
    name: g.name,
    description: g.description,
  }));
  const rosterRanked = rankCandidates(query, rosterCandidates);
  const rosterBest = rosterRanked[0];
  if (rosterBest && rosterBest.score >= MATCH_THRESHOLD) {
    const hit = existing.find((g) => g.id === rosterBest.id);
    if (hit) {
      return {
        gezelId: hit.id,
        name: hit.name,
        role: hit.role ?? opts.jobTitle,
        action: 'reused',
        matchScore: rosterBest.score,
        ...(rosterRanked.length > 1
          ? {
              alternatives: rosterRanked
                .slice(1, 4)
                .filter((c) => c.score > 0)
                .map((c) => c.id),
            }
          : {}),
      };
    }
  }

  // 2. Gilde: score template catalog; on a confident hit, create from
  // the template's curated about.
  const resolved = await resolveGildeTemplateForRole(catalog, query);
  if (resolved) {
    const { name: chosenName, gender: chosenGender } = pickNameAndGender({
      preferredName: opts.preferredName,
      ...(resolved.nameSuggestions ? { suggestions: resolved.nameSuggestions } : {}),
    });
    const created = await store.createGezel({
      name: chosenName,
      role: resolved.role,
      gender: chosenGender,
      about: resolved.about,
      templateId: resolved.templateId,
      templateVersion: resolved.templateVersion,
      ...(resolved.frontmatter ? { frontmatter: resolved.frontmatter } : {}),
    });
    return {
      gezelId: created.id,
      name: created.name,
      role: created.role ?? resolved.role,
      action: 'created-from-gilde',
      matchScore: resolved.matchScore,
      templateId: resolved.templateId,
    };
  }

  // 3. Bespoke fallback. Interactive recruitment gets a Klerk-authored
  // about.md. Runtime task routing uses the deterministic version: a task
  // transition happens inside another gezel's MCP call, so synchronously
  // asking the same local engine to author a persona can queue behind the
  // caller and deadlock the transition.
  const bespokeAbout =
    bespokeMode === 'static'
      ? staticSpecialistAbout(opts.jobTitle)
      : await generateGezelAbout(chat, opts.jobTitle);
  const { name: chosenName, gender: chosenGender } = pickNameAndGender({
    preferredName: opts.preferredName,
  });
  const created = await store.createGezel({
    name: chosenName,
    role: opts.jobTitle,
    gender: chosenGender,
    about: bespokeAbout,
  });
  return {
    gezelId: created.id,
    name: created.name,
    role: created.role ?? opts.jobTitle,
    action: 'created-bespoke',
  };
}

/**
 * Safe last-resort persona for runtime recruitment when no curated template
 * matches. It is intentionally useful but generic: the exact role remains in
 * the identity and the task/craftbook prompt supplies the concrete procedure.
 * A later explicit edit can still replace this about.md with a richer persona.
 */
export function staticSpecialistAbout(jobTitle: string): string {
  const role = jobTitle
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[*_`#[\]<>]/g, '')
    .slice(0, 160);
  return `## Identity

You are the crew's **${role || 'specialist'}**. You bring focused professional judgment to tasks that call for this role.

## Working style

- Read the project brief, task notes, and current step before acting.
- Work from concrete evidence in the project files; distinguish facts from assumptions.
- Produce the deliverable requested by the active step, then verify it against the stated checks.
- Keep changes scoped and explain material risks, uncertainty, or missing inputs plainly.

## Collaboration

- Respect project permissions and the task's trust boundaries.
- Leave concise handoff notes so the next crew member can continue without reconstructing your work.
- Ask for help when a required decision or authority belongs to the user.
`;
}

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
export async function resolveGildeTemplateForRole(
  catalog: CatalogService,
  jobTitle: string,
): Promise<GildeTemplateResolution | null> {
  const query = jobTitle.trim();
  if (!query) return null;
  const gildeItems = await catalog.list('gezel-template');
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
  const detail = await catalog.get('gezel-template', best.id);
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

/**
 * Resolve `{ name, gender }` for a new gezel. Precedence:
 *   1. caller-supplied `preferredName` wins — gender is inferred from
 *      the name (pool lookup, NB flip applied once).
 *   2. template `nameSuggestions` list (image-generator's "Picasso",
 *      "Vermeer", …) — gender inferred the same way.
 *   3. random draw from the gendered pools via `pickRandomNameWithGender`
 *      — name and gender come paired so the NB flip isn't re-rolled by
 *      the Store's inference fallback.
 */
function pickNameAndGender(opts: {
  preferredName?: string;
  suggestions?: readonly string[];
}): { name: string; gender: GezelGender } {
  const preferred = opts.preferredName?.trim();
  if (preferred) {
    return { name: preferred, gender: inferGenderForName(preferred) };
  }
  if (opts.suggestions && opts.suggestions.length > 0) {
    const idx = Math.floor(Math.random() * opts.suggestions.length);
    const suggested = opts.suggestions[idx];
    if (suggested) return { name: suggested, gender: inferGenderForName(suggested) };
  }
  return pickRandomNameWithGender();
}

/**
 * Validate the catalog manifest's `frontmatter` against the gezel
 * frontmatter schema. The catalog package keeps it loose
 * (`record(unknown)`) so the schema can evolve without rev'ing the
 * catalog package; here, at install time, we tighten so a
 * malformed template fails loudly instead of silently writing junk
 * into a fresh gezel.
 *
 * Returns `null` only when the template carries no frontmatter
 * extension at all. Most templates ship one: every role template
 * declares a `suggestedTuningProfile` (so the role's sampling preset
 * hydrates at request time via `resolveTuning`), and fixed-function
 * templates additionally carry a `fixedFunction` block.
 */
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

/** Exported for tests — asserts the "reused" branch without creating anything. */
export async function _scoreReuse(
  store: Store,
  query: string,
): Promise<{ id: string; score: number } | null> {
  const existing = await store.listGezels();
  const ranked = rankCandidates(
    query,
    existing.map((g) => ({
      id: g.id,
      role: g.role,
      name: g.name,
      description: g.description,
    })),
  );
  const best = ranked[0];
  if (!best || best.score < MATCH_THRESHOLD) return null;
  return { id: best.id, score: best.score };
}

export type { MatchCandidate } from './match.js';
