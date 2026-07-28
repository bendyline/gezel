import type { GateScriptRef } from '../schemas/gate.js';
import type { ModelTier } from './tier.js';
import { tierAtLeast } from './tier.js';

/**
 * ─ Roles as capability contracts ─────────────────────────────────────
 *
 * A role is not a persona — it is a declared bundle of what the system
 * does with it. Historically those facets were scattered: the toolset kit
 * lived in `chat/role-tool-filter`, the tuning profile in each gilde
 * template manifest, the about text in the catalog, and the "gate
 * vocabulary" only existed implicitly. This module makes the bundle
 * explicit and is the single source of truth for:
 *
 *   - `toolsetGroups`          — the MCP kit (was ROLE_TOOLSET_GROUPS)
 *   - `suggestedTuningProfile` — sampling preset (was template-only)
 *   - `gateAffinity`           — NEW: the checks a role's deliverables
 *                                default to (a Researcher cites + grounds
 *                                the way a Developer parses + tests)
 *   - `defaultBooks`           — NEW: craftbook templates the role runs well
 *   - `capabilityFloor`        — NEW: min model tier for unsupervised steps
 *
 * The about template stays in the catalog (it's prose, versioned with the
 * gallery); everything mechanical lives here. `chat/role-tool-filter` and
 * the tuning resolver read from this registry rather than re-declaring.
 *
 * IMPORTANT — behavior parity: the canonical role ids below are exactly
 * the 10 toolset-kit keys that `role-tool-filter` shipped, and
 * {@link resolveRoleId} reproduces the old `canonicalRoleKey` exactly
 * (exact-match a canonical id, else substring-match the alias table, else
 * null → DEFAULT_TOOLSET_GROUPS). Adding a brand-new canonical id would
 * change tool filtering AND the delegation/implementer classification that
 * keys off the canonical string, so keep this set stable; template-only
 * roles (builder → developer, boekwachter → default) continue to resolve
 * via the alias/fallback paths.
 */

export type RoleId =
  | 'meester'
  | 'voorman'
  | 'reviewer'
  | 'researcher'
  | 'copywriter'
  | 'designer'
  | 'image-generator'
  | 'video-generator'
  | 'developer'
  | 'web-developer'
  | 'planner';

export interface RoleDefinition {
  /** Canonical role id — also the toolset-kit key. */
  id: RoleId;
  /** Human label. */
  label: string;
  /** One-line capability summary. */
  summary: string;
  /**
   * MCP toolset groups (ids into BUILTIN_TOOLSETS) the role's gezels get
   * by default. Group lists are conservative: a missing-but-needed group
   * is worse than a couple extras; user toolsets add/remove from here.
   */
  toolsetGroups: readonly string[];
  /**
   * Soft tuning-profile default (a `KNOWN_PROFILE_IDS` value). The
   * per-gezel pick and install default always win; this is the role's
   * sensible baseline. Omitted where the role has no opinion.
   */
  suggestedTuningProfile?: string;
  /**
   * The gate vocabulary this role is expected to clear — standard-scope
   * check scripts that fit the role's typical deliverable. Inputs are
   * usually omitted here (bound to the concrete deliverable at the point
   * of use); this is the menu, not a turnkey gate. Empty for coordinators
   * (no deliverable) and for developer-family roles whose gates are
   * task-specific build/test checks supplied by the craftbook.
   */
  gateAffinity: readonly GateScriptRef[];
  /** Craftbook template ids (catalog folder names) this role runs well. */
  defaultBooks: readonly string[];
  /** Minimum model tier to run this role's steps unsupervised. */
  capabilityFloor: ModelTier;
}

/** Build a standard-scope gate-script ref (the gateAffinity vocabulary). */
function std(name: string, inputs?: Record<string, unknown>): GateScriptRef {
  return inputs ? { name, scope: 'standard', inputs } : { name, scope: 'standard' };
}

export const ROLES: Record<RoleId, RoleDefinition> = {
  // Meester surface, post-trim: `tasks-readonly` plus the narrow
  // `craftbook-launch` front door. The latter may create a procedure-backed
  // task, but all subsequent mutation lives with the voorman/assignee.
  // No `web` group (research routes through ask_specialist({ role:
  // 'researcher' }) — one schema vs. five web tools, meaningful for
  // tier:medium locals).
  meester: {
    id: 'meester',
    label: 'Meester',
    summary: 'Coordinator: delegates work across the gezel workforce; does not build directly.',
    toolsetGroups: [
      'team-management',
      'tasks-readonly',
      'craftbook-launch',
      'craftbooks',
      'artifacts',
      'memory',
      'documents',
      'doc-intel',
      'entity-intel',
      'interaction',
      'history',
      'handboek',
    ],
    suggestedTuningProfile: 'thinking-precise',
    gateAffinity: [],
    defaultBooks: ['status-report', 'weekly-review'],
    capabilityFloor: 'medium',
  },
  // Voorman gets `workspace-fs-read` (NOT -write) so they can investigate
  // a reported bug and produce a meaningful handoff, then delegate the fix
  // to a developer. Write/exec stay off so they don't drift into building.
  // No `web` (same reasoning as Meester) — keeps the roster off the tiny-
  // local stall threshold.
  //
  // No `code-intel` either: symbol-level navigation
  // (outline_file / find_symbol / read_symbol / find_references / map_repo /
  // search_code) is the DEVELOPER's surface — the voorman reads to diagnose
  // (workspace-fs-read covers readFile/search_files/find_files) and then
  // delegates the deep code work. Those 6 tools were ~pure roster tax on a
  // coordinator that never calls them, and on a medium local model (the
  // qwen3.6-27b/MLX 37K-token prefill stall) every tool schema costs
  // first-token latency. Removing the group also keeps the voorman under the
  // tier cap so its REAL tools (tasks/craftbooks/delegation) aren't evicted.
  voorman: {
    id: 'voorman',
    label: 'Voorman',
    summary: 'Foreman: triages, diagnoses, and routes work to specialists; read-only investigator.',
    toolsetGroups: [
      'team-management',
      'tasks',
      'craftbooks',
      'artifacts',
      'documents',
      'doc-intel',
      'memory',
      'interaction',
      'history',
      'workspace-fs-read',
      'handboek',
    ],
    suggestedTuningProfile: 'thinking-general',
    gateAffinity: [],
    defaultBooks: ['investigate-root-cause', 'release-readiness-review', 'bug-fix-tdd'],
    capabilityFloor: 'medium',
  },
  // Reviewer: full read+write+git surface plus `web` (and Playwright via
  // the rolePermitsBrowserAutomation gate) for PR review and live QA.
  reviewer: {
    id: 'reviewer',
    label: 'Reviewer',
    summary: 'Reviews code and deliverables; verifies claims against sources before approving.',
    toolsetGroups: [
      'workspace-fs-read',
      'workspace-fs-write',
      'code-intel',
      'security-intel',
      'git',
      'tasks',
      'artifacts',
      'memory',
      'documents',
      'doc-intel',
      'entity-intel',
      'interaction',
      'web',
      'handboek',
    ],
    suggestedTuningProfile: 'thinking-precise',
    // A review must point at real evidence — cited paths/URLs must resolve.
    gateAffinity: [std('checkCitationsResolve')],
    defaultBooks: [
      'pull-request-review',
      'design-review',
      'deep-security-review',
      'pr-security-review',
      'test-coverage-review',
    ],
    capabilityFloor: 'medium',
  },
  // Researcher: read sources + file long-form analysis to disk
  // (workspace-fs-write is load-bearing — the about converts the
  // consultation reply into a writeFile). `tasks-readonly` (reads task
  // context, doesn't mutate) and no `git`. `web` + write retained, so the
  // role still qualifies for browser automation (navigates live sites).
  researcher: {
    id: 'researcher',
    label: 'Researcher',
    summary:
      'Answers questions from sources; cites every claim and grounds facts in authorized inputs.',
    toolsetGroups: [
      'workspace-fs-read',
      'workspace-fs-write',
      'code-intel',
      'doc-intel',
      'entity-intel',
      'tasks-readonly',
      'artifacts',
      'memory',
      'documents',
      'interaction',
      'web',
      'handboek',
    ],
    suggestedTuningProfile: 'thinking-general',
    // The headline of 2.1: a researcher's outputs default to citation +
    // grounding gates. checkValueGrounding's `facts` are bound per task.
    gateAffinity: [std('checkCitationsResolve'), std('checkValueGrounding')],
    defaultBooks: [
      'research-report',
      'literature-review',
      'competitive-analysis',
      'due-diligence-brief',
      'fact-check',
    ],
    capabilityFloor: 'medium',
  },
  copywriter: {
    id: 'copywriter',
    label: 'Copywriter',
    summary: 'Drafts comms and marketing copy under length/tone constraints.',
    toolsetGroups: [
      'workspace-fs-read',
      'workspace-fs-write',
      'documents',
      'doc-intel',
      'tasks',
      'artifacts',
      'web',
      'memory',
      'interaction',
      'handboek',
    ],
    suggestedTuningProfile: 'creative',
    // Copy lives or dies on constraints: length bands and readability.
    gateAffinity: [std('checkWordBand'), std('checkReadingLevel')],
    defaultBooks: [
      'blog-post',
      'landing-copy',
      'press-release',
      'email-sequence',
      'product-descriptions',
    ],
    capabilityFloor: 'small',
  },
  designer: {
    id: 'designer',
    label: 'Designer',
    summary: 'Designs visual deliverables; generates and places imagery into pages.',
    toolsetGroups: [
      'workspace-fs-read',
      'workspace-fs-write',
      'images',
      'image-intel',
      'tasks',
      'artifacts',
      'documents',
      'web',
      'memory',
      'interaction',
      'handboek',
    ],
    suggestedTuningProfile: 'creative',
    // A design page's image references must resolve to real assets.
    gateAffinity: [std('checkImageRefsResolve')],
    defaultBooks: ['hero-image', 'landing-page', 'moodboard', 'svg-animation', 'logo-set'],
    capabilityFloor: 'small',
  },
  // Image generation specialists — built around `generate_image`. No
  // `workspace-fs-write`: the image route already drops a workspace copy
  // at assets/generated/, so a generator has no business calling writeFile
  // (the petshop "wrote prose into logo.png" fabrication).
  'image-generator': {
    id: 'image-generator',
    label: 'Image Generator',
    summary: 'Produces images via generate_image; no direct file writes.',
    toolsetGroups: [
      'images',
      'image-intel',
      'tasks',
      'artifacts',
      'documents',
      'memory',
      'interaction',
      'handboek',
    ],
    gateAffinity: [std('checkImageRefsResolve')],
    defaultBooks: ['logo-set', 'icon-pack', 'hero-image', 'thumbnail-generator'],
    capabilityFloor: 'tiny',
  },
  // Video generation specialists — built around `generate_video`. Same
  // no-`workspace-fs-write` rationale as image-generator: the video route
  // already drops a workspace copy at assets/generated/, so a generator
  // has no business calling writeFile.
  'video-generator': {
    id: 'video-generator',
    label: 'Video Generator',
    summary: 'Produces short video clips via generate_video; no direct file writes.',
    toolsetGroups: [
      'videos',
      'tasks',
      'artifacts',
      'documents',
      'memory',
      'interaction',
      'handboek',
    ],
    gateAffinity: [],
    defaultBooks: [],
    capabilityFloor: 'tiny',
  },
  // Generic developer — backend/scripts/general code. Trimmed for tier:tiny
  // on-device models: no `documents` (project about auto-injects) and no
  // `web` (doc lookups route through ask_specialist), which also keeps the
  // Playwright surface off (rolePermitsBrowserAutomation needs write+web).
  // Web-flavored titles alias to `web-developer`, which restores both.
  developer: {
    id: 'developer',
    label: 'Developer',
    summary: 'Builds and fixes code; works to task-specific build and test gates.',
    toolsetGroups: [
      'workspace-fs-read',
      'workspace-fs-write',
      'code-intel',
      'code-execution',
      'git',
      'tasks',
      'artifacts',
      'memory',
      'interaction',
      'handboek',
    ],
    suggestedTuningProfile: 'thinking-coding',
    // Developer gates are deliverable-specific (the build-loop supplies
    // checkHtmlComplete / checkJsParses / test gates per task), so there
    // is no useful role-wide default here.
    gateAffinity: [],
    defaultBooks: ['build-loop', 'bug-fix-tdd', 'rest-api', 'refactor-module', 'cli-tool'],
    capabilityFloor: 'small',
  },
  // Web/frontend developer — generic dev surface plus `web`, and the
  // rolePermitsBrowserAutomation gate flips on so @playwright/mcp spawns.
  'web-developer': {
    id: 'web-developer',
    label: 'Web Developer',
    summary: 'Frontend/full-stack code with live browser work.',
    toolsetGroups: [
      'workspace-fs-read',
      'workspace-fs-write',
      'code-intel',
      'code-execution',
      'git',
      'tasks',
      'artifacts',
      'memory',
      'interaction',
      'web',
      'handboek',
    ],
    suggestedTuningProfile: 'thinking-coding',
    gateAffinity: [],
    defaultBooks: [
      'landing-page',
      'spa-dashboard',
      'web-app-crud',
      'portfolio-site',
      'pwa-offline',
    ],
    capabilityFloor: 'small',
  },
  planner: {
    id: 'planner',
    label: 'Planner',
    summary: 'Turns a brief into a structured, owned, checkable plan.',
    toolsetGroups: [
      'tasks',
      'team-management',
      'artifacts',
      'documents',
      'doc-intel',
      'memory',
      'interaction',
      'web',
      'handboek',
    ],
    suggestedTuningProfile: 'thinking-precise',
    // Plans are gate-graphs in prose: ordered sections, an owned,
    // checkable action table, and structurally valid dependencies
    // (owners on-roster, deps resolve/acyclic, done-states checkable).
    gateAffinity: [std('checkOrderedSections'), std('checkTableShape'), std('checkPlanStructure')],
    defaultBooks: [
      'spec-doc',
      'proposal-sow',
      'dashboard-spec',
      'board-deck',
      'onboarding-checklist',
    ],
    capabilityFloor: 'medium',
  },
};

/**
 * Fallback group set when a gezel's role matches no canonical id and no
 * alias. Mirrors a competent builder kit; `code-execution` is deliberately
 * excluded (a more specific grant roles opt into). Was `DEFAULT_GROUPS` in
 * role-tool-filter.
 */
export const DEFAULT_TOOLSET_GROUPS: readonly string[] = [
  'memory',
  'documents',
  'doc-intel',
  'workspace-fs-read',
  'workspace-fs-write',
  'code-intel',
  'tasks',
  'artifacts',
  'web',
  'interaction',
  'handboek',
];

/**
 * Coarse role-name aliases mapping the variations users/LLMs produce onto
 * canonical role ids. ORDER MATTERS — checked top-to-bottom, first match
 * wins (web-flavored dev titles must precede the generic `developer`
 * matcher; image-generator must follow `design`). Consulted via substring
 * on the normalized role string only when the exact-id lookup misses.
 */
export const ROLE_ALIASES: ReadonlyArray<{ contains: string; canonical: RoleId }> = [
  { contains: 'meester', canonical: 'meester' },
  { contains: 'voorman', canonical: 'voorman' },
  { contains: 'foreman', canonical: 'voorman' },
  // Coach-titled roles (Loopbaancoach, Fitness Coach, …) run their project's
  // cadence: they need the voorman kit's team-management (message_gezel — the
  // coach-to-specialist handoff) and craftbooks groups, which the default kit
  // lacks.
  { contains: 'coach', canonical: 'voorman' },
  { contains: 'researcher', canonical: 'researcher' },
  { contains: 'research', canonical: 'researcher' },
  { contains: 'analyst', canonical: 'researcher' },
  { contains: 'reviewer', canonical: 'reviewer' },
  { contains: 'review', canonical: 'reviewer' },
  { contains: 'designer', canonical: 'designer' },
  { contains: 'design', canonical: 'designer' },
  // Dutch craft roles shipped as craftbook `suggestedRole`s (character-sheet,
  // character-turnaround, tileset-batch): a tekenaar draws and an assetsmid
  // forges game assets — both need the designer kit's `images` group, or the
  // gezel `ensureGezel` creates for the step can never call render_image /
  // generate_image (cbmx-20260720: image books shipped .json stubs).
  { contains: 'tekenaar', canonical: 'designer' },
  { contains: 'assetsmid', canonical: 'designer' },
  { contains: 'copywriter', canonical: 'copywriter' },
  { contains: 'writer', canonical: 'copywriter' },
  // Storyteller (page-spread's seeded worker role) — prose kit.
  { contains: 'verhalenverteller', canonical: 'copywriter' },
  { contains: 'planner', canonical: 'planner' },
  { contains: 'plan', canonical: 'planner' },
  // Web-flavored dev roles — BEFORE the generic `developer` matcher, since
  // "Web Developer"/"Frontend Developer" contain `developer`.
  { contains: 'web developer', canonical: 'web-developer' },
  { contains: 'web-developer', canonical: 'web-developer' },
  { contains: 'frontend', canonical: 'web-developer' },
  { contains: 'front-end', canonical: 'web-developer' },
  { contains: 'front end', canonical: 'web-developer' },
  { contains: 'full-stack', canonical: 'web-developer' },
  { contains: 'fullstack', canonical: 'web-developer' },
  { contains: 'full stack', canonical: 'web-developer' },
  // Developer-flavored roles — generic (tighter) kit. `builder` maps here
  // (it has its own catalog template/about + tuning, but shares the dev
  // toolset kit, as it always has).
  { contains: 'developer', canonical: 'developer' },
  { contains: 'engineer', canonical: 'developer' },
  { contains: 'programmer', canonical: 'developer' },
  { contains: 'builder', canonical: 'developer' },
  { contains: 'coder', canonical: 'developer' },
  { contains: 'devops', canonical: 'developer' },
  // Image-generator-flavored roles — AFTER design so "Visual Designer"
  // still routes to the designer kit.
  { contains: 'image generator', canonical: 'image-generator' },
  { contains: 'image-generator', canonical: 'image-generator' },
  { contains: 'image generation', canonical: 'image-generator' },
  { contains: 'image-generation', canonical: 'image-generator' },
  { contains: 'video generator', canonical: 'video-generator' },
  { contains: 'video-generator', canonical: 'video-generator' },
  { contains: 'video generation', canonical: 'video-generator' },
  { contains: 'video-generation', canonical: 'video-generator' },
];

/**
 * Resolve a free-form role/job-title to a canonical role id. Reproduces
 * the old `canonicalRoleKey` exactly:
 *   1. exact case-insensitive match against a canonical id, else
 *   2. first substring match in {@link ROLE_ALIASES}, else
 *   3. null (caller falls back to {@link DEFAULT_TOOLSET_GROUPS}).
 */
export function resolveRoleId(role: string | undefined): RoleId | null {
  if (!role) return null;
  const key = role.toLowerCase().trim();
  if (key in ROLES) return key as RoleId;
  for (const alias of ROLE_ALIASES) {
    if (key.includes(alias.contains)) return alias.canonical;
  }
  return null;
}

/** The full role definition for a free-form role, or null if unrecognized. */
export function roleDefinition(role: string | undefined): RoleDefinition | null {
  const id = resolveRoleId(role);
  return id ? ROLES[id] : null;
}

/**
 * Toolset groups a role gets by default — resolves the role and falls back
 * to {@link DEFAULT_TOOLSET_GROUPS}. This is the single implementation
 * behind `role-tool-filter`'s `roleToolsetGroups`.
 */
export function toolsetGroupsForRole(role: string | undefined): readonly string[] {
  const id = resolveRoleId(role);
  return id ? ROLES[id].toolsetGroups : DEFAULT_TOOLSET_GROUPS;
}

/** Suggested tuning profile id for a role, or undefined. */
export function roleSuggestedTuningProfile(role: string | undefined): string | undefined {
  return roleDefinition(role)?.suggestedTuningProfile;
}

/** The gate vocabulary a role's deliverables default to ([] if unknown). */
export function roleGateAffinity(role: string | undefined): readonly GateScriptRef[] {
  return roleDefinition(role)?.gateAffinity ?? [];
}

/**
 * A role's gateAffinity bound to a concrete deliverable `filePath` — each
 * affinity script gets `{ file: filePath }` merged into its inputs (an
 * explicit input on the ref still wins). This is the menu; the caller is
 * responsible for dropping any entry whose remaining required inputs can't
 * be satisfied (e.g. `checkValueGrounding` needs task-specific `facts`),
 * since this module can't see the script metas.
 */
export function roleDeliverableScripts(
  role: string | undefined,
  filePath: string,
): GateScriptRef[] {
  return roleGateAffinity(role).map((ref) => ({
    ...ref,
    inputs: { file: filePath, ...(ref.inputs ?? {}) },
  }));
}

/** Craftbook templates a role runs well ([] if unknown). */
export function roleDefaultBooks(role: string | undefined): readonly string[] {
  return roleDefinition(role)?.defaultBooks ?? [];
}

/** Minimum model tier for a role's unsupervised steps, or null if unknown. */
export function roleCapabilityFloor(role: string | undefined): ModelTier | null {
  return roleDefinition(role)?.capabilityFloor ?? null;
}

/**
 * Whether a model of `tier` clears a role's capability floor. Unknown
 * roles return true (don't block on a role we can't classify).
 */
export function meetsCapabilityFloor(tier: ModelTier, role: string | undefined): boolean {
  const floor = roleCapabilityFloor(role);
  return floor === null ? true : tierAtLeast(tier, floor);
}
