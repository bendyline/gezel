import type { GezelConfig, ProviderName, ResolvedSecurityPolicy } from '@bendyline/gezel';
import { resolveRoleId, toolsetGroupsForRole } from '@bendyline/gezel';
import { BUILTIN_TOOLSETS } from '@bendyline/gezel-catalog';
import { canonicalToolName } from '@bendyline/gezel-mcp';
import {
  extractExplicitFileEditTools,
  hasDirectFileDeliverableWording,
  hasExplicitFullFileRewriteWording,
  isSingleFileSourceRepairRequest,
} from '../providers/direct-file-work-prompt.js';
import { classifyLocalModelTier, classifyModelTier } from './local-model-tier.js';

/**
 * Configured backend for the `web_search` MCP tool. Mirrors the enum in
 * `webSearch.provider` (api.ts schemas). Kept as a string literal union
 * here so role-tool-filter can branch on "real keyed backend vs not"
 * without pulling the search-provider module into the chat layer.
 */
export type WebSearchBackendName = 'brave' | 'wikipedia' | 'tavily' | 'mock';

const BUILTIN_BY_ID = new Map(BUILTIN_TOOLSETS.map((g) => [g.id, g]));

/**
 * Backward-compat aliases for builtin group ids that have been split
 * or renamed since launch. Lookup happens before the BUILTIN_BY_ID
 * miss-and-skip path so an installed toolset that still references the old id keeps
 * resolving to the right tools.
 *
 * - `workspace-fs` was split into `workspace-fs-read` + `workspace-fs-write`
 *   (the voorman-needs-read-access fix). Anyone who had
 *   the old composite group in a toolsetsGroupOverride keeps both halves
 *   without manual migration.
 */
const LEGACY_GROUP_ALIASES: Record<string, readonly string[]> = {
  'workspace-fs': ['workspace-fs-read', 'workspace-fs-write'],
};

/** Expand a list of group ids to the flat set of MCP tool names. */
export function expandToolsetGroups(groupIds: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const id of groupIds) {
    const expandedIds = LEGACY_GROUP_ALIASES[id] ?? [id];
    for (const expandedId of expandedIds) {
      const g = BUILTIN_BY_ID.get(expandedId);
      if (!g) continue;
      for (const t of g.tools) out.add(t);
    }
  }
  return out;
}

/**
 * Resolve a free-form role/job-title to its canonical key, or null. Thin
 * wrapper over the core role registry's `resolveRoleId` — the role-keyed
 * classification sets below (delegation / direct-implementer / urgent-
 * writer) depend on getting the same canonical strings this always
 * returned, and the registry reproduces the old logic exactly.
 */
function canonicalRoleKey(role: string | undefined): string | null {
  return resolveRoleId(role);
}

/**
 * Group ids a role gets by default. Delegates to the core role registry
 * (`toolsetGroupsForRole`: exact id → alias substring → DEFAULT_TOOLSET_
 * GROUPS) — the single source of truth for the per-role kit. Kept as a
 * thin re-export so the `roleToolAllowlist` / `roleHasTeamScope` helpers
 * and external callers are unaffected by the move into core.
 */
export function roleToolsetGroups(role: string | undefined): readonly string[] {
  return toolsetGroupsForRole(role);
}

/** Tool-name allowlist for a role (its default groups, expanded). */
export function roleToolAllowlist(role: string | undefined): Set<string> {
  return expandToolsetGroups(roleToolsetGroups(role));
}

/**
 * Whether a gezel SESSION should carry the cross-project `team` capability
 * on its scoped MCP token — true exactly when its role gets the
 * `team-management` group AND the project isn't a solo "job" (which strips
 * it, mirroring `computeToolAllowlist`'s `projectMode === 'solo'` branch).
 * Sharing this source keeps the token's cross-project reach from drifting
 * from the team tools the model is actually offered: a coordinator (meester
 * / voorman / planner) gets `team` and may operate across projects; a plain
 * worker doesn't and is confined to its session's project.
 */
export function roleHasTeamScope(role: string | undefined, projectMode?: 'crew' | 'solo'): boolean {
  if (projectMode === 'solo') return false;
  return roleToolsetGroups(role).includes('team-management');
}

/**
 * Strip `team-management` from a list of group ids. Used for solo
 * projects ("jobs") where one ambachtsman handles everything and must
 * not reach for `ensure_gezel`, `message_gezel`, `create_gezel*`,
 * `create_project`, etc. — the Meester already chose one specialist
 * for the job, and team-building tools at this layer would just
 * tempt the model to fan out unnecessarily.
 *
 * Applied regardless of role. A "voorman"-roled gezel running a solo
 * project still loses team-management — they are an ambachtsman in
 * that context, not a voorman.
 */
function stripTeamManagement(groups: readonly string[]): readonly string[] {
  return groups.filter((g) => g !== 'team-management');
}

/**
 * Coordination roles that delegate work DOWN to the doer roles — they
 * get the full `role-delegation` group (delegate_/consult_ for
 * developer, designer, reviewer, planner, researcher, builder, writer,
 * image-generator). Every other role (and unknown roles) gets the
 * smaller `role-delegation-escalation` group (reach voorman/meester).
 * Only consulted when the `tools.gezels-as-roles` behavior is active.
 */
const DELEGATION_ORCHESTRATOR_ROLES: ReadonlySet<string> = new Set([
  'meester',
  'voorman',
  'planner',
]);

function roleDelegationGroups(role: string | undefined): readonly string[] {
  const canonical = canonicalRoleKey(role);
  if (canonical && DELEGATION_ORCHESTRATOR_ROLES.has(canonical)) return ['role-delegation'];
  return ['role-delegation-escalation'];
}

/**
 * True for the role-typed delegation tools (`delegate_<role>` /
 * `consult_<role>`). Used by the tier-cap + project-orchestration-constraint
 * logic to EXEMPT these from trimming when the `tools.gezels-as-roles`
 * behavior is active — so the delegation surface (the feature under test)
 * always reaches the model, while the rest of the toolset stays capped
 * exactly as today (keeping control vs treatment a clean A/B). No other
 * tool uses these prefixes.
 */
export function isRoleDelegationTool(name: string): boolean {
  return name.startsWith('delegate_') || name.startsWith('consult_');
}

/**
 * Tools removed from the resolved allowlist for consultation-mode
 * sessions (sessions spawned by `askGezelAndWait` / `ask_specialist`).
 * Strip both team-management (handled at the group level via
 * `stripTeamManagement` for tier ergonomics) AND the onward
 * consultation tools — a specialist invoked to answer ONE question
 * shouldn't be able to `ask_specialist` themselves and spiral into
 * "let me consult a designer about this question."
 *
 * `ask_user_question` stays — the addendum asks the model not to use
 * it unless genuinely ambiguous, but keeping it on the allowlist
 * means the runtime won't reject a legitimate clarification request.
 *
 * Task-management tools also stay: the consultation might naturally
 * reference task notes or write a brief artifact-shaped reply, and
 * stripping `write_task_note` would forbid a perfectly reasonable
 * "let me leave context for the asker" move.
 */
const CONSULTATION_STRIPPED_TOOLS: ReadonlySet<string> = new Set(['ask_specialist', 'ask_gezel']);

/**
 * Meester-only tools stripped from a default-roster Voorman. The Voorman
 * is a foreman WITHIN one project: she recruits with `ensure_gezel`,
 * routes with `message_gezel`, sees the roster with `list_gezels`, and
 * owns her project record with `update_project` — all of which she keeps.
 * What she never does (her about.md never names these) is the Meester's
 * kickoff surface: start new projects/jobs, fetch a remote repo, browse or
 * provision from the gilde, hand-create/edit gezels, or page through every
 * project. Those tools ride in the shared `team-management` group, so the
 * Voorman is GRANTED them by default — but offering ~10 tools she can't use
 * just bloats her roster (the qwen3.6-27b repro: 92 registered),
 * and the tier cap then has to trim that bloat, evicting her REAL tools to
 * make room. Strip them by NAME here so the group (and thus her
 * cross-project `team` token scope via {@link roleHasTeamScope}) is
 * untouched — the same surgical move {@link CONSULTATION_STRIPPED_TOOLS}
 * makes for `ask_specialist`/`ask_gezel`.
 */
const VOORMAN_STRIPPED_MEESTER_TOOLS: ReadonlySet<string> = new Set([
  'create_gezel',
  'update_gezel',
  'list_gilde',
  'list_projects',
  'start_project',
  'start_job',
  'fetch_repo',
  'fetch_diff',
]);

/**
 * Image-generation delegation tools stripped from a default-roster Voorman
 * The Voorman keeps the full `role-delegation` group — handing
 * structured work to a developer / designer / reviewer / etc. is HOW she gets
 * things done — but `delegate_image_generator` / `consult_image_generator` are
 * dead weight on the software-project voorman this roster targets: she has no
 * `images` / `generate_image` surface herself, and image work, when a project
 * needs it, routes through a designer. Stripped by NAME (not by group) because
 * the pair rides inside `role-delegation`, which she must keep — the same
 * surgical move {@link VOORMAN_STRIPPED_MEESTER_TOOLS} makes for the Meester
 * kickoff tools that ride inside `team-management`. Trimming them shaves the
 * per-turn tool-schema prefill that pushed the qwen3.6-27b/MLX repro into its
 * first-token stall. The Meester / Planner keep the pair.
 */
const VOORMAN_STRIPPED_DELEGATION_TOOLS: ReadonlySet<string> = new Set([
  'delegate_image_generator',
  'consult_image_generator',
]);

/**
 * Developer-shaped gezels own implementation handoffs. In the petshop
 * eval (qwen3.6-27b-q8/MLX) a Builder with an explicit
 * `index.html` deliverable still spent its first turn on `ask_specialist`
 * instead of creating the file. Upstream Meester/Voorman roles keep the
 * consultation surface; builders/developers get the direct-write lane.
 */
const DIRECT_IMPLEMENTER_ROLES: ReadonlySet<string> = new Set(['developer', 'web-developer']);
const URGENT_FILE_WRITER_ROLES: ReadonlySet<string> = new Set([
  'copywriter',
  'developer',
  'researcher',
  'web-developer',
  'reviewer',
]);
const PROJECT_RETRIEVAL_ROLES: ReadonlySet<string> = new Set([
  'developer',
  'meester',
  'researcher',
  'reviewer',
  'voorman',
  'web-developer',
]);
/**
 * `run_script` + `get_script_run` ride along in every file-work clamp:
 * a file deliverable whose content is EVIDENCE from an installed project
 * script (probe output, generated data) requires running that script —
 * clamping it away forces the model to fabricate the evidence instead.
 * Wild-caught (craftbook-ship live-mock pilot, gemma4-e4b): the kickoff
 * named `ship-report.md`, the clamp stripped `run_script`, and the model
 * spent every repair round rewriting prose while the fake services
 * logged zero requests. Same precedent as `run_nodejs_script` in
 * DIRECT_FILE_WORK_TOOLS.
 */
const FILE_WORK_SCRIPT_TOOLS: readonly string[] = ['run_script', 'get_script_run'];
const IMMEDIATE_FILE_WRITE_TOOLS: ReadonlySet<string> = new Set([
  'write_file',
  ...FILE_WORK_SCRIPT_TOOLS,
]);
/**
 * Tools left available when the immediate-file-write deliverable targets
 * an EXISTING substantial file — i.e. a modification, not a create.
 * Forcing a `write_file`-only full rewrite of a large file is the worst
 * option for a weak local model: re-emitting ~16 KB of HTML+JS reliably
 * corrupts the inline script (stray parens) or ships only a fragment, and
 * the source-write-guard then rejects every attempt. Wild-caught
 * (qwen3.6 a3b): a 15-line SVG insert into a 16.8 KB index.html
 * failed 5× because surgical edit tools were stripped. Keeping the patch
 * tools alongside `write_file` preserves the constraint's intent (every
 * tool here is a write — no consult/read distraction) while giving the
 * model a low-risk way to make a small edit without re-emitting the file.
 */
const IMMEDIATE_FILE_MODIFY_TOOLS: ReadonlySet<string> = new Set([
  'write_file',
  'replace_in_file',
  'replace_lines',
  'append_to_file',
  'insert_at_marker',
  ...FILE_WORK_SCRIPT_TOOLS,
]);
const SCENARIO_FILE_REPAIR_TOOLS: ReadonlySet<string> = new Set([
  'read_file',
  'list_dir',
  'stat',
  'validate',
  'replace_in_file',
  'replace_lines',
  'write_file',
  'append_to_file',
  ...FILE_WORK_SCRIPT_TOOLS,
]);
const DIRECT_FILE_WORK_TOOLS: ReadonlySet<string> = new Set([
  'read_file',
  'list_dir',
  'stat',
  'validate',
  'make_dir',
  'write_file',
  'append_to_file',
  'replace_in_file',
  'replace_lines',
  'run_nodejs_script',
  ...FILE_WORK_SCRIPT_TOOLS,
]);
const PROJECT_RETRIEVAL_HANDOFF_TOOLS: ReadonlySet<string> = new Set([
  'list_projects',
  'ensure_gezel',
  'ask_gezel',
  'message_gezel',
]);
const PROJECT_RETRIEVAL_DIRECT_TOOLS: ReadonlySet<string> = new Set([
  ...PROJECT_RETRIEVAL_HANDOFF_TOOLS,
  'search_code',
  'search_files',
  'find_symbol',
  'find_references',
  'map_repo',
]);
const REVIEW_FILE_REPAIR_TOOLS: ReadonlySet<string> = new Set([
  'replace_in_file',
  'replace_lines',
  'write_file',
  'append_to_file',
]);

/**
 * The github_* tools in the `git` toolset that hit the GitHub API and
 * 400 the instant a project has no `.github` link (see
 * `http/routes/github.ts` — every PR route guards on `!project.github`).
 * Gated on `githubLinked` so a gezel in a non-linked folder never sees
 * a tool that's guaranteed to fail. `run_git` is NOT here — it works in
 * any git repo regardless of remote, and is gated separately on
 * `isGitRepo`.
 */
const GITHUB_REMOTE_TOOLS: ReadonlySet<string> = new Set([
  'github_pr_list',
  'github_pr_view',
  'github_pr_files',
  'github_pr_diff',
  'github_pr_comments',
  'github_pr_comment',
  'github_pr_create',
  'github_workflow_runs',
  'github_check_status',
]);

/**
 * True when a role's default toolset groups contain neither
 * `workspace-fs-write` nor `code-execution` — i.e. the role is "pure
 * delegation": meant to coordinate other gezels rather than do work
 * itself. Today: Meester, Voorman, Planner.
 *
 * Note we check the *write* split, not read. Voorman gets
 * `workspace-fs-read` so they can investigate a bug before delegating
 * the fix; that doesn't make them a builder. The "do you build?"
 * marker is whether you can mutate the workspace.
 *
 * Used by the system-prompt builder to decide whether to inject the
 * "you route, you don't build" guardrail prose. Per-gezel toolset
 * overrides aren't consulted — toolset overrides change tool wiring but
 * don't change role intent — and the prose is generic enough that an
 * over-empowered Meester still reads "if I'm doing the work myself,
 * something's off" as good guidance.
 */
export function isPureDelegationRole(role: string | undefined): boolean {
  const groups = roleToolsetGroups(role);
  return !groups.includes('workspace-fs-write') && !groups.includes('code-execution');
}

/**
 * Whether a role gets the `@playwright/mcp` browser automation surface
 * (`browser_navigate`, `browser_click`, `browser_type`, `browser_evaluate`,
 * etc. — ~21 tools). This is distinct from the lightweight `web` group's
 * `web_search` + `fetch_url`, which every role gets for fact lookups.
 *
 * Heuristic: a role qualifies when its default groups include BOTH
 * `workspace-fs-write` (so it actually builds things) AND `web` (so it
 * does browser-shaped work). That gives Playwright to:
 *
 *   - `web-developer` — frontend / full-stack / scraping
 *   - `designer` — visual review of UIs they're touching
 *   - `reviewer` — QA on rendered pages
 *
 * And withholds it from:
 *
 *   - generic `developer` (post-split: scripts / backend / general code) —
 *     tighter roster keeps tier:tiny on-device models from drowning in
 *     a 70-tool function schema. Users whose dev work is browser-shaped
 *     either tag the role "Web Developer" (aliases to `web-developer`
 *     above) or install `@playwright/mcp` as a gezel-level toolset.
 *   - content roles (Copywriter) — they can read/write workspace copy
 *     files, but route browser-driven implementation/review to a
 *     developer, designer, or reviewer.
 *
 * Why both flags: pre-split, `workspace-fs-write` alone was the
 * "builds things" proxy and Playwright tracked it. Splitting developer
 * into web-developer (with `web`) + generic developer (without) made
 * `workspace-fs-write` too coarse — every developer aliased to
 * `developer` (including pure backend / Node-script work that never
 * touches a browser) was paying for 21 Playwright tools they'd never
 * call. The `web` group is now the explicit "I do web-shaped work"
 * marker; pairing it with `workspace-fs-write` keeps the rule honest:
 * we only spawn Playwright for roles that build *and* do web work.
 *
 * Used by `ChatManager` to decide whether to spawn the @playwright/mcp
 * bridge for this gezel's session. A power-user who explicitly installs
 * @playwright/mcp into a gezel's toolsets bypasses this gate — the
 * check fires only on the system-scope auto-bootstrap.
 */
export function rolePermitsBrowserAutomation(role: string | undefined): boolean {
  if (canonicalRoleKey(role) === 'copywriter') return false;
  const groups = roleToolsetGroups(role);
  return groups.includes('workspace-fs-write') && groups.includes('web');
}

/**
 * Project types (taxonomy ids) whose primary deliverable renders in a
 * browser. A builder gezel scoped to one of these needs to *see* its own
 * pages — the Space War incident: a generic Developer shipped a canvas
 * game whose first animation frame threw, and the role gate above meant
 * he had no browser to ever find out.
 */
const BROWSER_FACING_PROJECT_TYPES: ReadonlySet<string> = new Set([
  'browser-game',
  'web-app',
  'static-site',
  'design-prototype',
]);

export function projectTypeIsBrowserFacing(typeId: string | undefined): boolean {
  return typeId !== undefined && BROWSER_FACING_PROJECT_TYPES.has(typeId);
}

/**
 * The full auto-spawn decision for the system-scope `@playwright/mcp`
 * toolset: the role qualifies on its own (`web` + `workspace-fs-write`),
 * OR the role builds things (`workspace-fs-write`) and the *project's*
 * deliverable is browser-facing — a generic Developer on a browser-game
 * project gets the browser; the same Developer on a CLI project keeps
 * the lean roster. The copywriter carve-out survives the widening: their
 * about.md disclaims browser work regardless of project shape.
 *
 * `projectTypeId` is the effective taxonomy id — the user's explicit
 * `project.projectTypeId` override when set, else the persisted
 * `detectedProjectType.id` (only written above the detector's confidence
 * floor, so presence is signal enough).
 *
 * Both ChatManager gate sites (prompt-side roster and bridge-side spawn)
 * MUST call this same predicate — drift between them makes the system
 * prompt promise a different tool surface than the runtime exposes.
 */
export function permitsBrowserAutomation(opts: {
  role: string | undefined;
  projectTypeId: string | undefined;
}): boolean {
  if (rolePermitsBrowserAutomation(opts.role)) return true;
  if (canonicalRoleKey(opts.role) === 'copywriter') return false;
  const groups = roleToolsetGroups(opts.role);
  return groups.includes('workspace-fs-write') && projectTypeIsBrowserFacing(opts.projectTypeId);
}

function isStructuredFileWorkerRole(role: string | undefined): boolean {
  const text = (role ?? '').toLowerCase();
  return /\b(?:boekwachter|bookkeeper|record[-\s]?keeper|records[-\s]?(?:keeper|clerk|specialist)|data[-\s]?(?:entry|steward|clerk))\b/.test(
    text,
  );
}

function roleActsAsUrgentFileWriter(role: string | undefined): boolean {
  return (
    URGENT_FILE_WRITER_ROLES.has(canonicalRoleKey(role) ?? '') || isStructuredFileWorkerRole(role)
  );
}

function roleActsAsDirectFileWorker(role: string | undefined): boolean {
  return (
    DIRECT_IMPLEMENTER_ROLES.has(canonicalRoleKey(role) ?? '') || isStructuredFileWorkerRole(role)
  );
}

function roleCanUseProjectRetrievalFirst(role: string | undefined): boolean {
  return PROJECT_RETRIEVAL_ROLES.has(canonicalRoleKey(role) ?? '');
}

/**
 * Auto-approve EVERY tool exposed by our gezel-mcp server,
 * unconditionally. `mcp__<server>` (just the server prefix without a
 * specific tool name) is Claude CLI's wildcard for "any tool from
 * this server" — one entry covers our entire surface and stays
 * correct as we add new tools to gezel-mcp without touching this
 * file.
 *
 * Why unconditional: gezel-mcp is OUR server, running OUR code, doing
 * the things gezels are designed to do (memory, tasks, team
 * management, artifacts, documents, history). The user has already
 * approved that surface implicitly by using gezel. Popping a
 * permission card on every `save_memory` / `read_task_notes` /
 * `advance_task_step` is friction with no upside. We previously
 * narrowed this by role, but: (a) role-based narrowing left common
 * roles (Designer, Copywriter, anything custom) prompting on every
 * task tool, (b) the role-tool-filter ALREADY narrows the *visible*
 * surface — auto-approval is just about whether the model has to
 * pause for a permission card on a tool it does have access to.
 *
 * Extra MCP servers (Playwright, GitHub, etc.) are NOT covered here.
 * Those carry side effects beyond gezel-mcp's trusted surface
 * (real-browser navigation, GitHub API mutations) and keep flowing
 * through the `--permission-prompt-tool` path so the user sees a
 * card for each.
 *
 * The function still takes `opts` for parity with other allowlist
 * helpers; today every field is ignored.
 */
export function gezelMcpToolsToAllow(_opts: {
  role: string | undefined;
  mode: GezelConfig['toolFilterMode'];
  provider: ProviderName;
  modelId?: string;
  toolsetsGroupOverride?: readonly string[];
}): string[] {
  return ['mcp__gezel'];
}

/**
 * Decide whether a session should be tool-filtered, and if so, with
 * what set. Returns `null` when no filtering should happen — the
 * caller should pass every available tool to the model.
 *
 * Resolution order:
 *   1. `mode === 'never'`            → no filter
 *   2. `mode === 'small-model'`      → filter only when the model
 *                                       classifies as `tiny` (sub-5B
 *                                       on any local provider, or
 *                                       unknown size on a local
 *                                       provider)
 *   3. `mode === 'always'` (default) → always filter
 *
 * When filtering is active and `toolsetsGroupOverride` is non-empty, the
 * gezel's installed built-in toolsets win and the role default is
 * ignored. Otherwise the role default applies — improvements to the
 * default ship to every gezel that hasn't customized.
 *
 * Default mode changed from 'small-model' to 'always'
 * — TPM caps hit OpenAI/Copilot users too, not just local sub-5B
 * runs. Users who want everything can set `toolFilterMode: 'never'`
 * in their config.
 *
 * `'small-model'` mode delegates to {@link classifyLocalModelTier}
 * so the threshold matches the rest of the codebase. Previously this
 * function had its own `parameterBillions >= 5` check that was
 * scoped to Ollama only — mlx/llama-cpp users running 4B models
 * silently fell out of the filter. Routing through the tier
 * classifier fixes that and keeps the size taxonomy in one place.
 */
export function computeToolAllowlist(opts: {
  role: string | undefined;
  mode: GezelConfig['toolFilterMode'];
  provider: ProviderName;
  /**
   * Model id used to classify the tier when `mode === 'small-model'`.
   * Pass the gezel's pinned model or the provider's default — the
   * classifier handles unknown / unparsable ids by returning `tiny`,
   * which makes the filter conservative.
   */
  modelId?: string;
  /**
   * Authoritative parameter-size string from the catalog manifest or
   * provider metadata (e.g. `"27B"`, `"30.7B"`). Preferred over
   * `modelId` tag parsing inside the classifier — several catalog tags
   * drop the size suffix and would otherwise misclassify into `tiny`.
   */
  parameterSize?: string;
  /**
   * Built-in toolset group ids installed in this gezel's toolsets. When
   * non-empty, replaces the role default. Empty / undefined means
   * "inherit role default."
   */
  toolsetsGroupOverride?: readonly string[];
  /**
   * Mode of the project this session is scoped to. `solo` strips the
   * `team-management` group regardless of role (the project's
   * ambachtsman shouldn't recruit other gezels). Missing / `'crew'`
   * leaves the resolved groups untouched.
   */
  projectMode?: 'crew' | 'solo';
  /**
   * Set when the session was spawned by `askGezelAndWait` /
   * `ask_specialist`. Strips team-management AND the onward
   * consultation tools (`ask_specialist`, `ask_gezel`) so the
   * specialist focuses on the one question they were invoked to
   * answer instead of fanning out further consultations.
   */
  consultationMode?: boolean;
  /**
   * Configured `webSearch.provider` from the install config (or
   * undefined when no provider is set). Used to gate `web_search`:
   * we only expose it when a real keyed backend (Brave / Tavily /
   * Mock) is configured. Without one — or when the user picked
   * Wikipedia explicitly — `web_search` is misleading (the model
   * thinks it's hitting the open web but only sees Wikipedia hits)
   * and `wikipedia_search` is the honest tool to use instead. The
   * gate fires regardless of `mode`; it isn't a verbosity / TPM
   * trade-off, it's a "stop confusing the model" trade-off.
   */
  webSearchProvider?: WebSearchBackendName;
  /**
   * Whether the project has a GitHub link (`project.github`). When
   * false/undefined, the `github_*` tools in {@link GITHUB_REMOTE_TOOLS}
   * are stripped from the resolved allowlist — they'd 400 at the API
   * layer (every PR route guards on `!project.github`), so exposing
   * them just invites the model to burn a turn on a guaranteed failure.
   * Fires regardless of `mode` — like the search gates, this isn't a
   * verbosity trade-off, it's "don't show a tool that can't work."
   */
  githubLinked?: boolean;
  /**
   * Whether the session's working directory is a git repo (probed via
   * `inspectGitWorkdir`). When false, `run_git` is stripped — it works
   * with no remote but not outside a repo. Independent of
   * `githubLinked`: a repo with no GitHub link keeps `run_git` but
   * loses the `github_*` tools.
   */
  isGitRepo?: boolean;
  /**
   * Set when the `tools.gezels-as-roles` behavior is active on the
   * session's model profile. Appends the role-appropriate delegation
   * group(s) (`role-delegation` for orchestrators, `role-delegation-escalation`
   * for specialists) so `delegate_<role>` / `consult_<role>` tools surface,
   * AND strips the generic `ask_specialist` / `ask_gezel` dispatchers
   * (keeping `message_gezel` as a name-addressed escape hatch). Off /
   * undefined leaves the surface byte-identical to today.
   */
  rolesAsTools?: boolean;
  /**
   * Resolved centralized security posture (see
   * `resolveSecurityPolicy`). Applied as a hard ceiling that strips
   * code-execution / external-service / git tools when the posture
   * forbids them — independent of `mode`, so it fires even when role
   * filtering is otherwise off. Undefined leaves the surface untouched
   * (callers/tests that don't supply a policy keep prior behavior; the
   * production call sites always pass one). Workspace-write tools are
   * NOT gated here — see {@link workspaceWritable}.
   */
  securityPolicy?: ResolvedSecurityPolicy;
  /**
   * Effective per-project workspace writability (see
   * `projectWorkspaceWritable` in core). Explicit `false` strips the
   * `workspace-fs-write` tool group — the per-project replacement for
   * the old global `allowFileEdits` ceiling, so an internal-workspace
   * project keeps its write tools under super-lockdown while an
   * external folder without the opt-in (or a project the user set to
   * "edits off") loses them. `undefined` leaves the surface untouched.
   */
  workspaceWritable?: boolean;
}): Set<string> | null {
  const mode = opts.mode ?? 'always';

  // Tier is needed both for the small-model gate AND for the
  // wikipedia_search gate (cloud models have already inhaled
  // Wikipedia in pre-training; exposing the tool just adds a tool
  // schema they'll never beneficially call).
  const tier = classifyModelTier({
    providerName: opts.provider,
    modelId: opts.modelId,
    ...(opts.parameterSize !== undefined ? { parameterSize: opts.parameterSize } : {}),
  });

  // Search-tool gates fire independently of `mode`. Even when the
  // user has opted out of role filtering (`mode: 'never'`), we still
  // want to hide a tool that would actively confuse the model.
  const stripWebSearch =
    opts.webSearchProvider === undefined || opts.webSearchProvider === 'wikipedia';
  const stripWikipediaSearch = tier === 'cloud';

  // Git/GitHub gates also fire independently of `mode` — same reason as
  // the search gates: a tool that's guaranteed to fail (github_* with no
  // link) or is meaningless (run_git outside a repo) shouldn't be on the
  // surface even when the user opted out of role filtering. Explicit
  // `false` strips; `undefined` leaves the surface untouched so callers
  // that don't know the git state (and existing tests) keep prior
  // behavior. The production call site always passes concrete booleans.
  const stripGithub = opts.githubLinked === false;
  const stripRunGit = opts.isGitRepo === false;

  // Security posture is a hard ceiling that fires in every branch below
  // (including `mode: 'never'` and the small-model cap), so fold it into
  // the shared `applyGates` pass. Workspace-write tools are gated by the
  // per-project writability contract, not the global policy.
  const securityPolicy = opts.securityPolicy;
  const stripWorkspaceWrite = opts.workspaceWritable === false;
  const securityGatesActive =
    stripWorkspaceWrite ||
    (securityPolicy !== undefined &&
      !(
        securityPolicy.allowExternalServices &&
        securityPolicy.allowScriptExecution &&
        securityPolicy.allowModelGit
      ));

  const applyGates = (allow: Set<string>): Set<string> => {
    const gated = applyGitToolGates(
      applySearchToolGates(allow, { stripWebSearch, stripWikipediaSearch }),
      { stripGithub, stripRunGit },
    );
    return applySecurityPolicyGates(gated, securityPolicy, stripWorkspaceWrite);
  };

  const gatesActive =
    stripWebSearch || stripWikipediaSearch || stripGithub || stripRunGit || securityGatesActive;

  if (mode === 'never') {
    if (!gatesActive) return null;
    return applyGates(allBuiltinTools());
  }
  if (mode === 'small-model' && tier !== 'tiny') {
    if (!gatesActive) return null;
    return applyGates(allBuiltinTools());
  }

  const hasToolsetOverride = !!opts.toolsetsGroupOverride && opts.toolsetsGroupOverride.length > 0;
  const roleBaseGroups = hasToolsetOverride
    ? opts.toolsetsGroupOverride!
    : roleToolsetGroups(opts.role);
  // When the `tools.gezels-as-roles` behavior is on, append the
  // role-appropriate delegation group so `delegate_<role>` /
  // `consult_<role>` tools surface. Additive over both role-default and
  // custom-toolset surfaces.
  const baseGroups = opts.rolesAsTools
    ? [...roleBaseGroups, ...roleDelegationGroups(opts.role)]
    : roleBaseGroups;
  // Consultation sessions get the same group-level strip solo
  // projects do — no team-management at the group layer. The
  // CONSULTATION_STRIPPED_TOOLS pass below additionally removes
  // specific tool names that don't have their own group.
  const needsTeamStrip = opts.projectMode === 'solo' || opts.consultationMode === true;
  const groups = needsTeamStrip ? stripTeamManagement(baseGroups) : baseGroups;
  let resolved = applyGates(expandToolsetGroups(groups));
  // Compatibility floor for installs/watch sessions where core's role
  // registry already names the narrow `craftbook-launch` group but the
  // catalog package serving builtin group metadata has not rebuilt yet.
  // A Meester told to suggest a craftbook must also be able to invoke the
  // selected procedure; otherwise the routing prompt creates a dead end.
  if (
    !hasToolsetOverride &&
    canonicalRoleKey(opts.role) === 'meester' &&
    resolved.has('suggest_craftbook') &&
    !resolved.has('invoke_craftbook')
  ) {
    resolved = new Set(resolved);
    resolved.add('invoke_craftbook');
  }
  // CONSULTATION_STRIPPED_TOOLS = { ask_specialist, ask_gezel } — exactly
  // the generic dispatchers we demote when role tools are active (we keep
  // message_gezel as a name-addressed escape hatch), so the rolesAsTools
  // demotion reuses the same strip.
  const stripOnwardConsultation =
    opts.consultationMode === true ||
    opts.rolesAsTools === true ||
    (!hasToolsetOverride && DIRECT_IMPLEMENTER_ROLES.has(canonicalRoleKey(opts.role) ?? ''));
  if (stripOnwardConsultation) {
    const next = new Set(resolved);
    for (const name of CONSULTATION_STRIPPED_TOOLS) next.delete(name);
    resolved = next;
  }
  // Trim the Meester-only kickoff tools from a default-roster Voorman (see
  // VOORMAN_STRIPPED_MEESTER_TOOLS). Skipped when the user hand-picked the
  // toolsets (`toolsetsGroupOverride`) — that's an explicit choice we honor.
  if (!hasToolsetOverride && canonicalRoleKey(opts.role) === 'voorman') {
    const next = new Set(resolved);
    for (const name of VOORMAN_STRIPPED_MEESTER_TOOLS) next.delete(name);
    // Also drop the image-generator delegation pair (see
    // VOORMAN_STRIPPED_DELEGATION_TOOLS) — only present at all when
    // `rolesAsTools` added `role-delegation`, so this is a no-op otherwise.
    for (const name of VOORMAN_STRIPPED_DELEGATION_TOOLS) next.delete(name);
    resolved = next;
  }
  // Surgical line-editing rides with content-editing. `replace_lines` (edit
  // by line number — read straight off the `read_file` gutter, no byte-exact
  // `find` string to reproduce) is the reliable surgical tool for small
  // models, which fumble `replace_in_file`'s find-matching. Wherever a role
  // gets `replace_in_file`, expose `replace_lines` too — they're siblings in
  // `workspace-fs-write`, and older curated toolsets / project overrides
  // predate `replace_lines`, so this backfills it. Wild-caught: a
  // gemma4-12b developer had `replace_in_file` but not `replace_lines`, so its
  // only surgical option demanded byte-matching it couldn't do — the prompt
  // told it to use `replace_lines` (absent), and it thrashed between a
  // guard-rejected full rewrite and unmatchable patches until it aborted.
  if (resolved.has('replace_in_file') && !resolved.has('replace_lines')) {
    const next = new Set(resolved);
    next.add('replace_lines');
    resolved = next;
  }
  return resolved;
}

export function constrainAllowlistForImmediateFileWrite(
  allowlist: Set<string> | null,
  opts: {
    role: string | undefined;
    latestUserMessage: string | undefined;
    hasToolsetOverride?: boolean;
    /**
     * The deliverable target is an existing, substantial file (a
     * modification, not a create). Keep the surgical patch tools
     * alongside `write_file` so a small edit doesn't force a full,
     * corruption-prone rewrite. The caller resolves this against the
     * workspace; defaults to false (the create path → `write_file` only).
     */
    existingSubstantialFile?: boolean;
  },
): Set<string> | null {
  if (!allowlist) return allowlist;
  if (!shouldConstrainToImmediateFileWrite(opts)) return allowlist;
  if (!allowlist.has('write_file')) return allowlist;
  const toolSet = opts.existingSubstantialFile
    ? IMMEDIATE_FILE_MODIFY_TOOLS
    : IMMEDIATE_FILE_WRITE_TOOLS;
  const next = new Set<string>();
  for (const name of toolSet) {
    if (allowlist.has(name)) next.add(name);
  }
  return next.size > 0 ? next : allowlist;
}

/**
 * Honor an explicit one-tool handoff contract. Local models sometimes turn
 * "your next and only action" into a permission question even when the
 * message supplies the exact tool call. In that narrow shape, exposing the
 * rest of the tool surface only creates invalid alternatives.
 */
export function extractImmediateNamedTool(message: string | undefined): string | null {
  const text = (message ?? '').trim();
  const directive = text.match(/your next and only\s+(?:assistant\s+)?action must be\b/i);
  if (!directive || directive.index === undefined) return null;
  const tail = text.slice(directive.index + directive[0].length, directive.index + 800);
  const call = tail.match(/`?([a-z][a-z0-9_]*)\s*\(/i);
  // Handoffs written before the snake_case rename (or replayed from old
  // sessions) may name the legacy spelling; resolve it so the allowlist
  // membership check downstream sees the canonical name.
  return call?.[1] ? canonicalToolName(call[1]) : null;
}

export function constrainAllowlistForImmediateNamedTool(
  allowlist: Set<string> | null,
  latestUserMessage: string | undefined,
): Set<string> | null {
  if (!allowlist) return allowlist;
  const tool = extractImmediateNamedTool(latestUserMessage);
  if (!tool || !allowlist.has(tool)) return allowlist;
  return new Set([tool]);
}

/**
 * Pull the deliverable target path out of the auto-injected
 * `[Deliverable expected as a FILE at \`<path>\`]` annotation, if present.
 * Used by the caller to decide whether the immediate-file-write target is
 * an existing substantial file (→ allow surgical edits) vs. a fresh
 * create (→ `write_file` only). Returns null when no annotation is found.
 */
export function extractDeliverableTargetPath(message: string | undefined): string | null {
  const m = (message ?? '').match(/\[Deliverable expected as a FILE at `([^`]+)`/i);
  return m?.[1]?.trim() ?? null;
}

function fileRepairToolsWithExplicitDirectives(
  base: ReadonlySet<string>,
  latestUserMessage: string | undefined,
): Set<string> {
  const tools = new Set(base);
  for (const name of extractExplicitFileEditTools(latestUserMessage)) tools.add(name);
  return tools;
}

export function constrainAllowlistForScenarioFileRepair(
  allowlist: Set<string> | null,
  opts: {
    role: string | undefined;
    latestUserMessage: string | undefined;
    hasToolsetOverride?: boolean;
  },
): Set<string> | null {
  if (!allowlist) return allowlist;
  if (!shouldConstrainToScenarioFileRepair(opts)) return allowlist;
  const text = (opts.latestUserMessage ?? '').trim();
  const baseToolSet =
    canonicalRoleKey(opts.role) === 'reviewer' && /\breview\.md\b/i.test(text)
      ? REVIEW_FILE_REPAIR_TOOLS
      : SCENARIO_FILE_REPAIR_TOOLS;
  const toolSet = fileRepairToolsWithExplicitDirectives(baseToolSet, text);
  const next = new Set<string>();
  for (const name of toolSet) {
    if (allowlist.has(name)) next.add(name);
  }
  return next.size > 0 ? next : allowlist;
}

export function constrainAllowlistForDirectFileWork(
  allowlist: Set<string> | null,
  opts: {
    role: string | undefined;
    latestUserMessage: string | undefined;
    hasToolsetOverride?: boolean;
    force?: boolean;
  },
): Set<string> | null {
  if (!allowlist) return allowlist;
  if (!opts.force && !shouldConstrainToDirectFileWork(opts)) return allowlist;
  const next = new Set<string>();
  const toolSet = fileRepairToolsWithExplicitDirectives(
    DIRECT_FILE_WORK_TOOLS,
    opts.latestUserMessage,
  );
  for (const name of toolSet) {
    if (allowlist.has(name)) next.add(name);
  }
  return next.size > 0 ? next : allowlist;
}

export function constrainAllowlistForExistingSourceEdit(
  allowlist: Set<string> | null,
  opts: {
    role: string | undefined;
    latestUserMessage: string | undefined;
    hasToolsetOverride?: boolean;
  },
): Set<string> | null {
  if (!shouldConstrainToExistingSourceEdit(opts)) return allowlist;
  const source = allowlist ?? allBuiltinTools();
  const next = new Set<string>();
  const toolSet = fileRepairToolsWithExplicitDirectives(
    SCENARIO_FILE_REPAIR_TOOLS,
    opts.latestUserMessage,
  );
  for (const name of toolSet) {
    if (source.has(name)) next.add(name);
  }
  return next.size > 0 ? next : allowlist;
}

export function constrainAllowlistForProjectRetrievalFirst(
  allowlist: Set<string> | null,
  opts: {
    role: string | undefined;
    latestUserMessage: string | undefined;
    hasToolsetOverride?: boolean;
    currentProjectId?: string;
  },
): Set<string> | null {
  if (!shouldConstrainToProjectRetrievalFirst(opts)) return allowlist;
  const available = allowlist ?? allBuiltinTools();
  const allTools = allBuiltinTools();
  const next = new Set<string>();
  const toolSet = projectRetrievalShouldHandoff(opts.latestUserMessage, opts.currentProjectId)
    ? PROJECT_RETRIEVAL_HANDOFF_TOOLS
    : PROJECT_RETRIEVAL_DIRECT_TOOLS;
  for (const name of toolSet) {
    if (available.has(name) || allTools.has(name)) next.add(name);
  }
  return next.size > 0 ? next : allowlist;
}

export function shouldConstrainToImmediateFileWrite(opts: {
  role: string | undefined;
  latestUserMessage: string | undefined;
  hasToolsetOverride?: boolean;
}): boolean {
  if (opts.hasToolsetOverride) return false;
  const roleKey = canonicalRoleKey(opts.role) ?? '';
  if (!roleActsAsUrgentFileWriter(opts.role)) return false;
  const text = (opts.latestUserMessage ?? '').trim();
  if (isScenarioFullRewriteNudge(text)) return true;
  // A handoff that affirmatively names an append/surgical mutation tool is
  // an existing-file edit, even when a stale generic annotation elsewhere in
  // the message mentions write_file. Preserve the requested tool surface.
  if (extractExplicitFileEditTools(text).length > 0) return false;
  if (isExistingScenarioCheckNudge(text)) return false;
  if (isScenarioSniffRepairNudge(text) || isRuntimeScenarioRepairNudge(text)) {
    return false;
  }
  // Message-matching regexes accept BOTH the canonical snake_case names
  // and the pre-rename spellings (`write_?file` matches `write_file` and,
  // case-insensitively, `writeFile`) — handoffs replayed from old
  // sessions and pinned gilde prose still say the old names.
  const expectedFilePath = text
    .match(/\[Deliverable expected as a FILE at `([^`]+)`/i)?.[1]
    ?.trim()
    .replace(/\\/g, '/')
    .toLowerCase();
  if (
    roleActsAsUrgentFileWriter(opts.role) &&
    expectedFilePath &&
    /first assistant action should be(?:\s+the tool call)?\s+`write_?file\s*\(\s*\{\s*path\s*,\s*content\s*\}\s*\)`/i.test(
      text,
    )
  ) {
    return true;
  }
  if (
    roleKey !== 'reviewer' &&
    /first move:\s+create the workspace deliverable/i.test(text) &&
    /next concrete action should land\s+(?:a\s+)?(?:(?:compact but complete|concise but substantive)\s+)?(?:workspace\/index\.html|workspace file)/i.test(
      text,
    ) &&
    /write_?file\s*\(\s*\{\s*path\s*:\s*["']index\.html["']/i.test(text)
  ) {
    return true;
  }
  if (roleKey !== 'reviewer' && isDirectCreateSourceWriteRequest(text)) {
    return true;
  }
  if (
    /(?:^|\]:\s*)direct kick from the eval harness:/i.test(text) &&
    /(?:deliverable hasn't landed|deliverable file hasn't reached its expected path)/i.test(text) &&
    /your next tool call MUST be\s+`write_?file`/i.test(text)
  ) {
    return true;
  }
  if (
    /^(?:\[[^\]]+\]:\s*)?\[scenario check\]\s+there is still\s+\*?\*?no\s+`[^`]+`\*?\*?\s+in the workspace/i.test(
      text,
    ) &&
    /write_?file\s*\(\s*\{\s*path\s*:/i.test(text) &&
    /do not end your turn until\s+`write_?file`/i.test(text)
  ) {
    return true;
  }
  return false;
}

export function shouldConstrainToScenarioFileRepair(opts: {
  role: string | undefined;
  latestUserMessage: string | undefined;
  hasToolsetOverride?: boolean;
}): boolean {
  if (opts.hasToolsetOverride) return false;
  if (!roleActsAsUrgentFileWriter(opts.role)) return false;
  const text = (opts.latestUserMessage ?? '').trim();
  if (isScenarioFullRewriteNudge(text)) return true;
  if (isExistingScenarioCheckNudge(text)) return true;
  if (isScenarioSniffRepairNudge(text)) return true;
  if (isSingleFileSourceRepairRequest(text)) return true;
  return isRuntimeScenarioRepairNudge(text);
}

export function shouldConstrainToDirectFileWork(opts: {
  role: string | undefined;
  latestUserMessage: string | undefined;
  hasToolsetOverride?: boolean;
}): boolean {
  if (opts.hasToolsetOverride) return false;
  if (!roleActsAsDirectFileWorker(opts.role)) return false;
  const text = (opts.latestUserMessage ?? '').trim();
  if (!text) return false;
  if (isScenarioFullRewriteNudge(text)) return false;
  if (isExistingScenarioCheckNudge(text)) return false;
  if (isScenarioSniffRepairNudge(text) || isRuntimeScenarioRepairNudge(text)) return false;
  if (!mentionsWorkspaceFilePath(text)) return false;
  return hasDirectFileDeliverableWording(text);
}

export function shouldConstrainToExistingSourceEdit(opts: {
  role: string | undefined;
  latestUserMessage: string | undefined;
  hasToolsetOverride?: boolean;
}): boolean {
  if (opts.hasToolsetOverride) return false;
  if (!roleActsAsUrgentFileWriter(opts.role)) return false;
  const text = (opts.latestUserMessage ?? '').trim();
  if (!text) return false;
  if (isRevisionForWorkspaceFile(text)) return true;
  if (isSingleFileSourceRepairRequest(text)) return true;
  if (!/\b(?:modify|update|change|add|continue evolving|refactor|edit)\b/i.test(text)) {
    return false;
  }
  if (!/\b(?:existing|same)\b(?:\s+[\w'-]+){0,5}\s+(?:codebase|file|app|project)\b/i.test(text)) {
    return false;
  }
  return /`?[\w./-]+\.(?:html?|css|mjs|cjs|js|jsx|ts|tsx|json|md)`?/i.test(text);
}

export function shouldConstrainToProjectRetrievalFirst(opts: {
  role: string | undefined;
  latestUserMessage: string | undefined;
  hasToolsetOverride?: boolean;
  currentProjectId?: string;
}): boolean {
  if (opts.hasToolsetOverride) return false;
  if (!roleCanUseProjectRetrievalFirst(opts.role)) return false;
  const text = (opts.latestUserMessage ?? '').trim();
  if (!text) return false;
  if (isRemoteRepoLikeRequest(text)) return false;
  if (/\b(?:build|create|make|develop|implement|prototype|ship|write|produce)\b/i.test(text)) {
    return false;
  }
  const asksToLocate =
    /\b(?:find|locate|where(?:\s+(?:is|are|do|does|did|was|were))?|which\s+(?:file|function|class|method|route|component)|what\s+(?:file|function|class|method|route|component)|show\s+me\s+where)\b/i.test(
      text,
    );
  if (!asksToLocate) return false;
  return /\b(?:project|repo|repository|codebase|workspace|source|file|function|class|method|route|component|module|symbol|definition|reference|usage|bug|error|handled|applied|defined|used|implemented)\b/i.test(
    text,
  );
}

function projectRetrievalShouldHandoff(
  text: string | undefined,
  currentProjectId: string | undefined,
): boolean {
  if (currentProjectId !== 'default') return false;
  const normalized = (text ?? '').trim();
  if (!normalized) return false;
  return (
    /\b(?:in|inside|within|for)\s+(?:the\s+)?(?:"[^"]+"|`[^`]+`|[\w.-]+)\s+project\b/i.test(
      normalized,
    ) || /\bproject\s+(?:"[^"]+"|`[^`]+`)\b/i.test(normalized)
  );
}

function isRemoteRepoLikeRequest(text: string): boolean {
  return (
    /https?:\/\/(?:github\.com|gitlab\.com|bitbucket\.org)\/[^\s)"'`<>]+/i.test(text) ||
    /https?:\/\/[^\s)"'`<>]+\.git(?:\b|[/?#])/i.test(text) ||
    /\b(?:fetch_repo|fetch_diff|clone\s+(?:the\s+)?repo)\b/i.test(text)
  );
}

function isRevisionForWorkspaceFile(text: string): boolean {
  return /^Revision\s+\d+\s+for\s+`?[\w./-]+\.(?:html?|css|mjs|cjs|js|jsx|ts|tsx|json|md)`?\s*:/i.test(
    text,
  );
}

function mentionsWorkspaceFilePath(text: string): boolean {
  if (!/`?[\w./-]+\.(?:html?|css|mjs|cjs|js|jsx|ts|tsx|json|md|csv|txt|ya?ml)`?/i.test(text)) {
    return false;
  }
  return (
    /`?(?:\.{0,2}\/)?[\w.-]+\/[\w./-]+\.(?:html?|css|mjs|cjs|js|jsx|ts|tsx|json|md|csv|txt|ya?ml)`?/i.test(
      text,
    ) ||
    /\b(?:workspace|write_?file|replace_?in_?file|replace_?lines|append_?to_?file|read_?file|fs\.writeFileSync|fs\.readFileSync|local validator|paths are relative)\b/i.test(
      text,
    )
  );
}

function isScenarioSniffRepairNudge(text: string): boolean {
  if (
    /^(?:\[[^\]]+\]:\s*)?\[scenario check\]\s+I looked at\s+`[^`]+`\s+and\s+the\s+success\s+criteria\s+aren't\s+met\s+yet\./i.test(
      text,
    )
  ) {
    return (
      /Signals that didn't fire:/i.test(text) &&
      /patch the deliverable/i.test(text) &&
      /\b(?:replace_?in_?file|write_?file|re-emit)\b/i.test(text)
    );
  }
  return false;
}

function isExistingScenarioCheckNudge(text: string): boolean {
  return /^(?:\[[^\]]+\]:\s*)?\[scenario check\]\s+I looked at\s+`[^`]+`\s+and\s+the\s+success\s+criteria\s+aren't\s+met\s+yet\./i.test(
    text,
  );
}

function isRuntimeScenarioRepairNudge(text: string): boolean {
  const header =
    /^(?:\[[^\]]+\]:\s*)?\[runtime check(?:\s+[^\]]+)?\]\s+I\s+(?:opened|re-opened)\s+`[^`]+`\s+(?:in\s+a\s+headless\s+browser|after\s+your\s+latest\s+edit)\./i.test(
      text,
    ) ||
    /^(?:\[[^\]]+\]:\s*)?\[runtime check(?:\s+[^\]]+)?\]\s+You've now rewritten\s+`[^`]+`\s+\d+\s+time\(s\)/i.test(
      text,
    );
  if (!header) return false;
  if (!/(?:assertion\(s\) failed:|SAME assertion\(s\) are still failing:|Failures:)/i.test(text)) {
    return false;
  }
  return /\b(?:page doesn'?t actually function|previous edit didn'?t address the cause|same defect|specific code|targeted patch|replace_?in_?file|write_?file|re-emit)\b/i.test(
    text,
  );
}

function isScenarioFullRewriteNudge(text: string): boolean {
  return (
    /\[(?:runtime check(?:\s+[^\]]+)?|scenario check)\]/i.test(text) &&
    hasExplicitFullFileRewriteWording(text)
  );
}

function isDirectCreateSourceWriteRequest(text: string): boolean {
  if (!/\bwrite_?file\b/i.test(text)) return false;
  if (!/`?[\w./-]+\.(?:html?|css|mjs|cjs|js|jsx|ts|tsx|json|md)`?/i.test(text)) {
    return false;
  }
  if (
    /\b(?:modify|repair|fix|debug|patch|refactor|continue evolving|existing codebase)\b/i.test(text)
  ) {
    return false;
  }
  if (/\bpreserve\b/i.test(text) && !/\bfirst (?:version|pass)\b/i.test(text)) return false;
  return (
    /\b(?:build|create|make|implement|scaffold|write|produce)\b/i.test(text) &&
    /\b(?:first version|first pass|initial version|new|from scratch|at\s+`?[\w./-]+\.(?:html?|css|mjs|cjs|js|jsx|ts|tsx|json|md)`?)/i.test(
      text,
    )
  );
}

/** Flat set of every tool name in `BUILTIN_TOOLSETS`. */
function allBuiltinTools(): Set<string> {
  const out = new Set<string>();
  for (const g of BUILTIN_TOOLSETS) for (const t of g.tools) out.add(t);
  return out;
}

function applySearchToolGates(
  allow: Set<string>,
  gates: { stripWebSearch: boolean; stripWikipediaSearch: boolean },
): Set<string> {
  if (!gates.stripWebSearch && !gates.stripWikipediaSearch) return allow;
  const next = new Set(allow);
  if (gates.stripWebSearch) next.delete('web_search');
  if (gates.stripWikipediaSearch) next.delete('wikipedia_search');
  return next;
}

function applyGitToolGates(
  allow: Set<string>,
  gates: { stripGithub: boolean; stripRunGit: boolean },
): Set<string> {
  if (!gates.stripGithub && !gates.stripRunGit) return allow;
  const next = new Set(allow);
  if (gates.stripGithub) for (const name of GITHUB_REMOTE_TOOLS) next.delete(name);
  if (gates.stripRunGit) next.delete('run_git');
  return next;
}

/**
 * Model-initiated outbound-service tools gated by `allowExternalServices`.
 * Note `wikipedia_search` lands here too: under a no-services posture even
 * the zero-key Wikipedia lookup is egress (it reveals what's being
 * researched), so super-lockdown strips it alongside the keyed backends.
 */
const EXTERNAL_SERVICE_TOOLS: ReadonlySet<string> = new Set([
  'web_search',
  'wikipedia_search',
  'fetch_url',
  // Email send/draft are external-service agency: a no-services posture
  // (lockdown / super-lockdown) strips them so a mail-enabled project's agent
  // can neither sync-driven-send nor draft outbound while locked down.
  'draft_email',
  'queue_email',
  'send_email',
]);

/**
 * Apply the centralized security posture plus the per-project workspace
 * writability to a resolved tool surface. This is a hard ceiling — it
 * fires in {@link computeToolAllowlist} regardless of `toolFilterMode`,
 * so opting out of role filtering can't smuggle a gated capability back
 * onto the surface. It only ever removes tools.
 *
 * `workspace-fs-write` is stripped when the PROJECT is not writable for
 * gezels (`projectWorkspaceWritable === false`) — the global policy's
 * `allowFileEdits` no longer factors in, so internal-workspace projects
 * keep their write tools under super-lockdown. `code-execution` is
 * stripped by group so the set tracks the catalog; `artifacts` is
 * deliberately never gated (the locked-down "write to the sandbox, not
 * the source" escape hatch).
 */
function applySecurityPolicyGates(
  allow: Set<string>,
  policy: ResolvedSecurityPolicy | undefined,
  stripWorkspaceWrite: boolean,
): Set<string> {
  const policyClear =
    !policy ||
    (policy.allowExternalServices && policy.allowScriptExecution && policy.allowModelGit);
  if (policyClear && !stripWorkspaceWrite) {
    return allow;
  }
  const next = new Set(allow);
  if (stripWorkspaceWrite) {
    for (const name of expandToolsetGroups(['workspace-fs-write'])) next.delete(name);
  }
  if (!policy) return next;
  if (!policy.allowScriptExecution) {
    for (const name of expandToolsetGroups(['code-execution'])) next.delete(name);
  }
  if (!policy.allowExternalServices) {
    for (const name of EXTERNAL_SERVICE_TOOLS) next.delete(name);
  }
  if (!policy.allowModelGit) {
    for (const name of GITHUB_REMOTE_TOOLS) next.delete(name);
    next.delete('run_git');
  }
  return next;
}

/**
 * Map of Claude CLI built-in tool names to the gezel toolset group that
 * "owns" each one. The Claude CLI provider passes the inverse — every
 * built-in NOT covered by a role's groups — as `--disallowedTools` so
 * the model literally cannot reach for that surface.
 *
 * Why we need this: the gezel-mcp `GEZEL_MCP_EXCLUDE` mechanism only
 * filters our MCP tool surface. Claude's built-in `Bash`/`Write`/`Edit`/
 * `Read`/`Grep`/`Glob`/`NotebookEdit`/`WebFetch`/`WebSearch` are
 * orthogonal — without `--disallowedTools`, a Meester whose toolset
 * groups exclude `workspace-fs-write` would still happily `Bash mkdir
 * spacewar && Write index.html`. This map is the bridge.
 *
 * `TodoWrite` is intentionally never disallowed — it's a session-local
 * scratch pad with no side effects, useful to every role. `Task`
 * (Claude's own subagent dispatcher) is also left to the default-allow
 * — gezels already have `ask_gezel`/`message_gezel` for delegation but
 * we don't want to fight a model that wants both.
 *
 * Read tools and write tools split along the same boundary as the
 * gezel-mcp `workspace-fs-read` / `workspace-fs-write` groups so the
 * Claude CLI surface tracks the same "investigate vs. mutate"
 * distinction — a Voorman with `workspace-fs-read` gets `Read`/`Grep`/
 * `Glob` for diagnosis without `Write`/`Edit`/`NotebookEdit` for the
 * fix.
 */
const CLAUDE_BUILTIN_BY_GROUP: Record<string, readonly string[]> = {
  'workspace-fs-read': ['Read', 'Grep', 'Glob'],
  'workspace-fs-write': ['Write', 'Edit', 'NotebookEdit'],
  'code-execution': ['Bash'],
  web: ['WebFetch', 'WebSearch'],
};

const ALL_GATED_CLAUDE_BUILTINS: readonly string[] = [
  ...CLAUDE_BUILTIN_BY_GROUP['workspace-fs-read']!,
  ...CLAUDE_BUILTIN_BY_GROUP['workspace-fs-write']!,
  ...CLAUDE_BUILTIN_BY_GROUP['code-execution']!,
  ...CLAUDE_BUILTIN_BY_GROUP.web!,
];

/**
 * Compute the list of Claude CLI built-in tools to pass via
 * `--disallowedTools` for a session, derived from the SAME role+toolsets
 * resolution that drives `computeToolAllowlist`. Returns `[]` for roles
 * whose groups cover everything (e.g., Developer) — meaning no
 * disallow flag is needed. Returns the full gated list for delegation
 * roles like Meester / Voorman / Planner whose groups intentionally
 * exclude `workspace-fs-*`/`code-execution`/`web`.
 *
 * Honors the same precedence as `computeToolAllowlist`:
 *   - `toolsetsGroupOverride` wins if non-empty.
 *   - Otherwise the role default applies.
 *   - When `mode === 'never'` the filter is bypassed entirely (the
 *     caller passes nothing to `--disallowedTools`).
 *   - When `mode === 'small-model'` we only filter for tiny-tier
 *     models — but that doesn't apply to the Claude CLI provider since
 *     the CLI runs cloud Claude, never a local sub-5B model. We
 *     evaluate the gate anyway for shape consistency; in practice it
 *     always falls through to "filter."
 */
export function claudeBuiltinsToDisallow(opts: {
  role: string | undefined;
  mode: GezelConfig['toolFilterMode'];
  provider: ProviderName;
  modelId?: string;
  /** See {@link computeToolAllowlist} — same precedence over `modelId`. */
  parameterSize?: string;
  toolsetsGroupOverride?: readonly string[];
}): string[] {
  const mode = opts.mode ?? 'always';
  if (mode === 'never') return [];
  if (mode === 'small-model') {
    const tier = classifyLocalModelTier({
      providerName: opts.provider,
      modelId: opts.modelId,
      ...(opts.parameterSize !== undefined ? { parameterSize: opts.parameterSize } : {}),
    });
    if (tier !== 'tiny') return [];
  }
  const groups =
    opts.toolsetsGroupOverride && opts.toolsetsGroupOverride.length > 0
      ? opts.toolsetsGroupOverride
      : roleToolsetGroups(opts.role);
  const allowed = new Set<string>();
  for (const g of groups) {
    const builtins = CLAUDE_BUILTIN_BY_GROUP[g];
    if (builtins) for (const t of builtins) allowed.add(t);
  }
  return ALL_GATED_CLAUDE_BUILTINS.filter((t) => !allowed.has(t));
}

/**
 * Inverse of {@link claudeBuiltinsToDisallow}: the gated built-ins this
 * role IS allowed to use, plus the always-allowed ones (`TodoWrite`).
 * Surfaced by the Claude CLI provider as `--allowedTools <comma-list>`
 * so those tools auto-approve without going through the
 * `--permission-prompt-tool` flow.
 *
 * Why we auto-approve: once role-tool-filter has already gated which
 * built-ins this gezel even has access to (Meester gets none of them,
 * Reviewer gets the workspace-read/write set, Developer gets all),
 * prompting on every Bash invocation inside the allowed surface is
 * just friction — the user has already implicitly approved by giving
 * the gezel that role. A Reviewer's Read/Write/Edit shouldn't pop a
 * permission card every time. MCP tools (gezel-mcp + extras like
 * @playwright/mcp) keep going through the prompt-tool path; only the
 * Claude built-ins listed here skip it.
 */
export function claudeBuiltinsToAllow(opts: {
  role: string | undefined;
  mode: GezelConfig['toolFilterMode'];
  provider: ProviderName;
  modelId?: string;
  /** See {@link computeToolAllowlist} — same precedence over `modelId`. */
  parameterSize?: string;
  toolsetsGroupOverride?: readonly string[];
}): string[] {
  // Auto-approval is tied to role-filtering being active. When the user
  // opted out of filtering (`mode: 'never'`, or `'small-model'` and the
  // active model is not tiny), we don't pre-approve gated built-ins —
  // every tool stays on the `--permission-prompt-tool` path, matching
  // pre-auto-approval behavior. `TodoWrite` is always-allowed
  // regardless (it has no side effects).
  const mode = opts.mode ?? 'always';
  if (mode === 'never') return ['TodoWrite'];
  if (mode === 'small-model') {
    const tier = classifyLocalModelTier({
      providerName: opts.provider,
      modelId: opts.modelId,
      ...(opts.parameterSize !== undefined ? { parameterSize: opts.parameterSize } : {}),
    });
    if (tier !== 'tiny') return ['TodoWrite'];
  }
  const groups =
    opts.toolsetsGroupOverride && opts.toolsetsGroupOverride.length > 0
      ? opts.toolsetsGroupOverride
      : roleToolsetGroups(opts.role);
  const allowedGated = new Set<string>();
  for (const g of groups) {
    const builtins = CLAUDE_BUILTIN_BY_GROUP[g];
    if (builtins) for (const t of builtins) allowedGated.add(t);
  }
  return [...allowedGated, 'TodoWrite'];
}
