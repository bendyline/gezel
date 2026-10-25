import {
  type GezelGender,
  type GildeTemplateResolution,
  gezelNamesInUse,
  inferGenderForName,
  legacyRoleKey,
  pickUnusedGezelName,
  pickUnusedSuggestedName,
  plainRoleTitle,
  resolveGezelTemplateById,
  resolveGezelTemplateForRole,
} from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import { generateGezelAbout } from '../about/generator.js';
import type { ChatManager } from '../chat/manager.js';
import type { Store } from '../fs/store.js';
import { MATCH_THRESHOLD, type MatchCandidate, rankCandidates } from './match.js';
import { titleCaseRole } from './role-title.js';

export interface EnsureGezelOptions {
  /** Free-form job title — "designer", "dev", "UX researcher", etc. */
  jobTitle: string;
  /** Caller-supplied first name. Only used when creating. */
  preferredName?: string;
  /**
   * Exact gilde template id. When set, a roster gezel created from that
   * template is reused, else one is created from exactly that template.
   * Falls through to the fuzzy `jobTitle` path only when the installed
   * catalog does not carry the template (an older content pin).
   */
  templateId?: string;
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

  const existing = await store.listGezels();
  const inUse = gezelNamesInUse(existing);

  // 0. Exact template, when the caller names one: the roster gezel made
  // from it, else a fresh gezel from precisely that template. Identity is
  // the template id, not a fuzzy score — a "Generalist" must never resolve
  // to whichever roster member happens to describe themselves as broad.
  if (opts.templateId) {
    const fromTemplate = existing.find((g) => g.templateId === opts.templateId);
    if (fromTemplate) {
      return {
        gezelId: fromTemplate.id,
        name: fromTemplate.name,
        role: fromTemplate.role ?? opts.jobTitle,
        action: 'reused',
        templateId: opts.templateId,
      };
    }
    const exact = await resolveGildeTemplateById(catalog, opts.templateId);
    if (exact) {
      const { name: chosenName, gender: chosenGender } = pickNameAndGender({
        preferredName: opts.preferredName,
        ...(exact.nameSuggestions ? { suggestions: exact.nameSuggestions } : {}),
        inUse,
      });
      const created = await store.createGezel({
        name: chosenName,
        role: exact.role,
        gender: chosenGender,
        about: exact.about,
        templateId: exact.templateId,
        templateVersion: exact.templateVersion,
        ...(exact.frontmatter ? { frontmatter: exact.frontmatter } : {}),
      });
      return {
        gezelId: created.id,
        name: created.name,
        role: created.role ?? exact.role,
        action: 'created-from-gilde',
        matchScore: exact.matchScore,
        templateId: exact.templateId,
      };
    }
  }

  // 1. Reuse: score the existing roster. A fixed-function gezel forwards one
  // message to one tool, so it never fills a role (see
  // resolveGezelTemplateForRole); step 0 still reuses one by template id.
  const rosterCandidates: MatchCandidate[] = existing
    .filter((g) => !g.fixedFunction)
    .map((g) => ({
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
      inUse,
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
  // The about.md keeps the raw title — it reads as prose ("You are the crew's
  // **marine biologist**"), where display casing would be wrong. Only the
  // frontmatter role, which the UI renders verbatim as a label, is cased.
  // An older craftbook's Dutch title ("kantoormeester") is written as its
  // plain role in both places.
  const roleQuery = legacyRoleKey(query) ? plainRoleTitle(query).toLowerCase() : query;
  const roleTitle = titleCaseRole(roleQuery);
  const bespokeAbout =
    bespokeMode === 'static'
      ? staticSpecialistAbout(roleQuery)
      : await generateGezelAbout(chat, roleQuery);
  const { name: chosenName, gender: chosenGender } = pickNameAndGender({
    preferredName: opts.preferredName,
    inUse,
  });
  const created = await store.createGezel({
    name: chosenName,
    role: roleTitle,
    gender: chosenGender,
    about: bespokeAbout,
  });
  return {
    gezelId: created.id,
    name: created.name,
    role: created.role ?? roleTitle,
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

export type { GildeTemplateResolution } from '@bendyline/gezel';
export async function resolveGildeTemplateForRole(
  catalog: CatalogService,
  jobTitle: string,
): Promise<GildeTemplateResolution | null> {
  return resolveGezelTemplateForRole(
    { list: () => catalog.list('gezel-template'), get: (id) => catalog.get('gezel-template', id) },
    jobTitle,
  );
}

export async function resolveGildeTemplateById(
  catalog: CatalogService,
  templateId: string,
): Promise<GildeTemplateResolution | null> {
  return resolveGezelTemplateById({ get: (id) => catalog.get('gezel-template', id) }, templateId);
}

/**
 * Resolve `{ name, gender }` for a new gezel. Precedence:
 *   1. caller-supplied `preferredName` wins — gender is inferred from
 *      the name (pool lookup, NB flip applied once).
 *   2. template `nameSuggestions` list (image-generator's "Picasso",
 *      "Vermeer", …) that no gezel uses yet — gender inferred the same way.
 *   3. random draw from the gendered pools that no gezel uses yet — name
 *      and gender come paired so the NB flip isn't re-rolled by the Store's
 *      inference fallback.
 */
function pickNameAndGender(opts: {
  preferredName?: string;
  suggestions?: readonly string[];
  inUse: ReadonlySet<string>;
}): { name: string; gender: GezelGender } {
  const preferred = opts.preferredName?.trim();
  if (preferred) {
    return { name: preferred, gender: inferGenderForName(preferred) };
  }
  if (opts.suggestions && opts.suggestions.length > 0) {
    return pickUnusedSuggestedName(opts.suggestions, opts.inUse);
  }
  return pickUnusedGezelName(opts.inUse);
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
/** Exported for tests — asserts the "reused" branch without creating anything. */
export async function _scoreReuse(
  store: Store,
  query: string,
): Promise<{ id: string; score: number } | null> {
  const existing = await store.listGezels();
  const ranked = rankCandidates(
    query,
    existing
      .filter((g) => !g.fixedFunction)
      .map((g) => ({
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
