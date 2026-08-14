import { z } from 'zod';
import { ClaudePermissionModeSchema } from './claude.js';
import { CodexPermissionModeSchema } from './codex.js';
import { EntityIdSchema } from './entity-id.js';

/** A credential destination is an exact HTTPS origin, never a URL path. */
export const HttpsOriginSchema = z
  .string()
  .url()
  .refine(
    (value) => {
      try {
        const url = new URL(value);
        return (
          url.protocol === 'https:' &&
          !url.username &&
          !url.password &&
          url.pathname === '/' &&
          !url.search &&
          !url.hash
        );
      } catch {
        return false;
      }
    },
    { message: 'must be an exact HTTPS origin (for example https://api.example.com)' },
  );

/**
 * Optional GitHub repo association. When set, the service ensures a local
 * checkout exists (preferring the project's `workingDir` if it already
 * contains the repo, otherwise cloning into `<workingDir>/gh/` or
 * `~/.gezel/projects/{id}/gh/`). The PAT used for clone + API access lives
 * in the shared `github` toolset, not on the project.
 */
export const ProjectGitHubSchema = z.object({
  // Accept any non-empty string. Git URLs come in many forms beyond
  // `https://`: ssh shorthand (`git@github.com:owner/repo`), local
  // filesystem paths (`/path/to/bare.git`), other-host references.
  // The strict `.url()` validator rejected the filesystem-path form
  // and broke Phase-3 worktree tests that use a local bare repo as
  // the upstream. Higher layers (the github sync code) parse the URL
  // and reject anything that doesn't shape up as a clonable ref.
  url: z.string().min(1),
  branch: z.string().optional(),
  /** Resolved absolute path to the working tree. Managed by the service. */
  checkoutDir: z.string().optional(),
  lastSyncedAt: z.string().optional(),
  /** Repo default branch (e.g. "main"), detected lazily and cached. Managed by the service. */
  defaultBranch: z.string().optional(),
});
export type ProjectGitHub = z.infer<typeof ProjectGitHubSchema>;

/**
 * One bound external-data source on a project. The credential lives in the
 * SecretStore (keyed `connector-<type>` / `id`), never here — this carries
 * only the binding + its opaque, adapter-shaped incremental-sync cursor.
 * Mail accounts are ordinary bindings (`type: mail-gmail` / `mail-imap` / …);
 * the historical `project.mail` stack was retired in the connector overhaul.
 */
export const ProjectConnectorBindingSchema = z.object({
  /** Stable binding id; also the SecretStore `fieldId` + corpus-slug seed. */
  id: z.string().min(1),
  /** The connector-type catalog id, e.g. `mail-gmail`, `linear-issues`. */
  type: z.string().min(1),
  /** Catalog source the type resolved from (provenance/pin). */
  sourceId: z.string().optional(),
  /** Pinned connector-type version. */
  version: z.string().optional(),
  displayName: z.string().optional(),
  /**
   * Artifact-relative corpus root (`data/<corpusName>`), resolved once at bind
   * time and never recomputed — renaming a binding must not strand its corpus.
   */
  corpusDir: z.string().optional(),
  /** Per-binding config, validated at bind time against the type's `configSchema`. */
  config: z.record(z.string(), z.unknown()).default({}),
  /** Opaque, adapter-shaped incremental-sync cursor. Persisted so resync resumes. */
  cursor: z.unknown().optional(),
  /** Pause syncing without unbinding. */
  disabled: z.boolean().optional(),
  lastSyncedAt: z.string().optional(),
  /** Last sync error, surfaced in the UI; cleared on the next success. */
  lastError: z.string().optional(),
});
export type ProjectConnectorBinding = z.infer<typeof ProjectConnectorBindingSchema>;

/**
 * Per-project override of the ambient voorman-nudge cadence. Missing
 * fields inherit from the global defaults (`GezelConfig.projectNudge`).
 * Set `enabled: false` to silence nudges on a specific project.
 */
export const ProjectNudgeConfigSchema = z.object({
  enabled: z.boolean().optional(),
  rapidIntervalMs: z.number().int().positive().optional(),
  slowIntervalMs: z.number().int().positive().optional(),
  recentActivityWindowMs: z.number().int().positive().optional(),
  rapidAttemptsBeforeBackoff: z.number().int().positive().optional(),
  /**
   * Grace period applied to the very first nudge a project ever
   * receives, measured from `project.createdAt`. Default per tempo;
   * setting `0` opts out (legacy behavior — first nudge fires as
   * soon as the rapid interval allows).
   */
  firstNudgeGraceMs: z.number().int().nonnegative().optional(),
});
export type ProjectNudgeConfig = z.infer<typeof ProjectNudgeConfigSchema>;

/**
 * Runtime state the scheduler updates after each nudge decision. Persisted
 * on `project.json` so cadence survives restarts. Not user-editable.
 */
export const ProjectNudgeStateSchema = z.object({
  lastNudgedAt: z.string().optional(),
  consecutiveRapidNudges: z.number().int().nonnegative().optional(),
});
export type ProjectNudgeState = z.infer<typeof ProjectNudgeStateSchema>;

/**
 * Optional visibility overrides for the supporting tabs on a project.
 * Missing fields preserve the UI's historical defaults: most tabs are visible,
 * while Map keeps its project-type-aware auto visibility. Chat and Settings
 * are structural entry points and therefore are not configurable here; Output
 * remains capability-driven by previewable content.
 */
export const ProjectTabVisibilitySchema = z
  .object({
    overview: z.boolean().optional(),
    tasks: z.boolean().optional(),
    approvals: z.boolean().optional(),
    workspace: z.boolean().optional(),
    artifacts: z.boolean().optional(),
    map: z.boolean().optional(),
  })
  .strict();
export type ProjectTabVisibility = z.infer<typeof ProjectTabVisibilitySchema>;

/**
 * Policy for workspace mutations that pass through Gezel-managed sinks
 * (builtin MCP tools, scripts, schedulers, and Store workspace routes).
 * Provider-native harnesses such as Codex CLI have their own sandbox posture.
 */
export const ProjectManagedWorkspaceWritePolicySchema = z.enum(['auto', 'allow', 'deny']);
export type ProjectManagedWorkspaceWritePolicy = z.infer<
  typeof ProjectManagedWorkspaceWritePolicySchema
>;

/**
 * Provenance recorded on `project.json` when a custom project type is applied
 * (see docs/project-types.md). Captures which type + version + source
 * outfitted the project, and the param values collected at adoption (used to
 * render the about/mission templates and seed files). Enables later
 * refresh/upgrade against the installed type version.
 */
export const ProjectTypeProvenanceSchema = z.object({
  /** Catalog id of the applied project type. */
  id: z.string(),
  /** Type version installed at adoption. */
  version: z.string(),
  /** Catalog source the type resolved from (`bundled` | `local` | `community` | …). */
  source: z.string(),
  /** Param values collected at adoption, substituted into templates + seed files. */
  params: z.record(z.string(), z.unknown()).optional(),
  /** ISO timestamp of adoption. */
  appliedAt: z.string(),
});
export type ProjectTypeProvenance = z.infer<typeof ProjectTypeProvenanceSchema>;

export const ProjectSchema = z.object({
  id: EntityIdSchema,
  name: z.string(),
  description: z.string().optional(),
  workingDir: z.string().optional(),
  /** Optional gezel that acts as the project's voorman (foreman). Surfaces in
   *  the project detail pane, flows into the system prompt when a session is
   *  scoped here. For solo projects (`mode === 'solo'`) this same field
   *  holds the project's Builder — the data is unchanged, only the
   *  label flips. */
  voormanGezelId: z.string().optional(),
  /**
   * Internal marker: ISO timestamp of the one-time automatic voorman
   * assignment. The indexer ensures every project ends up with a voorman
   * — adopting the `@project` gezel minted from an AGENTS.md/CLAUDE.md, or
   * (when there's no instruction file) promoting an existing roster gezel.
   * Set once a voorman has been ensured so a later *manual* clear isn't
   * silently re-populated on the next scan. Not user-editable; absent on
   * projects last written before this field existed.
   */
  voormanAutoAssignedAt: z.string().optional(),
  /**
   * Roster — gezels that have been pulled into this project. Populated
   * automatically the first time a gezel is set as voorman, opens a
   * session scoped here, is pinged via `message_gezel` / `ask_gezel`,
   * or is assigned to a task; can also be edited explicitly via the
   * `add_gezel_to_project` / `remove_gezel_from_project` MCP tools.
   *
   * Advisory: not used to gate access — any gezel can still chat or be
   * assigned to a task here; the roster is for "team" UX surfacing,
   * notification scoping, and tracking who actually does work in the
   * project. Order is not significant. Missing on disk → empty roster
   * (back-compat with every project written before this field
   * existed).
   */
  gezelIds: z.array(z.string()).optional(),
  /**
   * Suggested-work keys the user has dismissed ("don't offer this again
   * here"). Advisory UI state, same spirit as `gezelIds`: enabling a
   * dismissed key un-dismisses it, and a materialized host always
   * outranks a dismissal. Keys are the stable suggested-work identities
   * (`gezel-template:<templateId>:<craftbookId>[#N]` /
   * `project-type:<typeId>:<scheduleKey>`). Deliberately not exposed
   * through the model-facing `update_project` MCP tool.
   */
  suggestedWorkDismissed: z.array(z.string()).optional(),
  /**
   * Shared per-project configuration values ("project properties") that
   * craftbook params and features draw from — e.g. `content.language`,
   * the designated language a translator gezel targets. Keys are ids
   * from the well-known registry in `project-properties.ts`, but unknown
   * ids are allowed (the registry improves display, it doesn't gate).
   * Values are plain strings; empty string is treated as unset.
   */
  properties: z.record(z.string(), z.string()).optional(),
  /**
   * Project shape. `crew` (the default) is the original behavior — the
   * voorman recruits and coordinates a team of specialists. `solo` is a
   * "job" — a single Builder (stored in
   * `voormanGezelId`) handles the whole project themselves; team-
   * management MCP tools are stripped from their session, and the
   * Meester is instructed not to nominate other gezels. Missing → `crew`
   * for back-compat with every project on disk before this field
   * existed.
   */
  mode: z.enum(['crew', 'solo']).optional(),
  /**
   * Optional custom label for this project's lead gezel, overriding the
   * mode-based default ("Voorman" / "Builder") everywhere the UI
   * renders it. Set by a project type at adoption (e.g. checkers →
   * "Opponent"); absent → the mode default. The data field stays
   * `voormanGezelId` — only the label changes.
   */
  leadLabel: z.string().optional(),
  /**
   * Lean-agent profile (set by a project type at adoption, e.g. checkers).
   * When true, sessions here get a minimal tool surface (the type's script
   * tools + `ask_user_question` only) and a lean prompt (no developer-agent
   * scaffolding). Keeps small local models from being overwhelmed on a
   * focused single-purpose task. Absent → the full agent profile.
   */
  leanProfile: z.boolean().optional(),
  /**
   * Per-project workspace-indexing switch. Missing/true preserves the
   * historical behavior: structural discovery plus the content-index refresh
   * run in the background. `false` opts this project out entirely — useful for
   * lightweight stateful project types such as board games or language
   * practice, whose small JSON workspace does not benefit from code search,
   * maps, summaries, or reviews.
   *
   * This does not disable chat/session history, memories, or the global
   * document index. Project-type manifests may seed the value at adoption and
   * the user can override it later in Project Settings.
   */
  indexingEnabled: z.boolean().optional(),
  github: ProjectGitHubSchema.optional(),
  connectors: z.array(ProjectConnectorBindingSchema).optional(),
  nudgeConfig: ProjectNudgeConfigSchema.optional(),
  nudgeState: ProjectNudgeStateSchema.optional(),
  /**
   * Per-project visibility for optional top-level tabs. Omitted keys preserve
   * the UI's historical default. Project-type manifests may seed these flags
   * during adoption and the user can override them later from Project Settings.
   */
  tabVisibility: ProjectTabVisibilitySchema.optional(),
  /**
   * Policy for Gezel-managed workspace mutations. `auto` (and an absent
   * value) permits internal workspaces and denies external `workingDir`s;
   * `allow` and `deny` are explicit user choices. Provider-native harnesses
   * are resolved separately through their own permission posture.
   */
  managedWorkspaceWritePolicy: ProjectManagedWorkspaceWritePolicySchema.optional(),
  /**
   * Legacy persistence field. New writers use `managedWorkspaceWritePolicy`;
   * readers retain this boolean so existing project.json files remain valid.
   *
   * @deprecated Use `managedWorkspaceWritePolicy` and the centralized
   * `projectManagedWorkspaceWritable` resolver.
   */
  allowGezelWrites: z.boolean().optional(),
  /**
   * Per-project Codex execution posture selected from the project status bar.
   * It overrides per-gezel/install Codex defaults so the visible control is
   * authoritative for every Codex session in this project.
   */
  codexPermissionMode: CodexPermissionModeSchema.optional(),
  /**
   * Per-project Claude CLI posture selected from the project status bar.
   * It overrides per-gezel/install Claude defaults for every Claude session
   * in this project.
   */
  claudePermissionMode: ClaudePermissionModeSchema.optional(),
  /**
   * Operational state for ambient gezel work on this project.
   *
   * - `active` (default when unset): normal operation. Meester nudges
   *   fire, task phase auto-advance dispatches handoffs, cron ticks
   *   record, and pending work rehydrates on boot.
   * - `readonly`: the project is paused for review/audit. All of the
   *   above pause. Chat still works — gezels can answer direct user
   *   questions — but no ambient work fires. No write-blocking in this
   *   pass; revisit once we see how it lands.
   * - `inactive`: deliberately paused. Identical ambient-pause semantics as
   *   `readonly` for now; unlike `archived`, an inactive project remains in
   *   the primary project navigation.
   * - `stable`: the project has come to rest — all its tasks are
   *   terminal (complete/canceled), so there is nothing to advance.
   *   Ambient nudges pause (same gate as readonly/inactive) but, unlike
   *   those deliberate user pauses, `stable` is a SOFT, automatic state:
   *   the task lifecycle sets it (last active task closed → stable) and
   *   clears it (any new or resumed task → active; see
   *   `TaskManager.reactivateProject`). It exists so a finished project
   *   stops pinging its voorman "anything stuck?" without the user or a
   *   weak local model having to take an explicit action. Reversible and
   *   non-destructive; chat and direct tool calls keep working.
   */
  status: z.enum(['active', 'readonly', 'inactive', 'stable']).optional(),
  /**
   * Bury this project in the navigation without deleting it. Archived
   * projects remain available from the dedicated section in the full
   * Projects view. The Store enforces `archived: true` => `status: inactive`
   * so background work cannot continue on a buried project.
   *
   * Missing/false means visible in the ordinary project UX, preserving
   * compatibility with projects written before archiving existed.
   */
  archived: z.boolean().optional(),
  /**
   * Per-project override of the `run_nodejs_script` wall-clock
   * timeout. Clamped between 30 seconds and 30 minutes. Missing →
   * the service-side default (5 min) applies.
   */
  workspaceScriptTimeoutMs: z
    .number()
    .int()
    .min(30_000)
    .max(30 * 60_000)
    .optional(),
  /**
   * Named credentials this project is explicitly allowed to use.
   * Credentials are stored once globally in `SecretStore`; a grant
   * here is the explicit user-driven permission for scripts or MCP
   * tools running in this project to resolve the named credential.
   * Missing → no credentials granted. See `scripts/dispatcher.ts`
   * and `secrets/registry.ts` for resolution.
   */
  grantedCredentials: z.array(z.string()).optional(),
  /**
   * Advanced exact-origin bindings for toolset credentials. Built-in provider
   * credentials are service-pinned and webhook credentials follow the
   * configured webhook URL, so entries for those names are ignored.
   */
  credentialAllowedOrigins: z.record(z.string(), z.array(HttpsOriginSchema)).optional(),
  /**
   * Explicit user override of the project's type (an id from the bundled
   * project-type taxonomy, see `project-types/taxonomy.ts`). When set, it
   * wins over `detectedProjectType` for craftbook suggestions. Cleared
   * (unset) → fall back to auto-detection. Missing on every project written
   * before this field existed.
   */
  projectTypeId: z.string().optional(),
  /**
   * Auto-detected project type, recomputed on each content-index scan from
   * the workspace file mix + about/mission text. Not user-editable — the
   * user expresses an override via `projectTypeId`. Absent until the first
   * scan classifies the project (or when nothing scores above the floor).
   */
  detectedProjectType: z
    .object({
      id: z.string(),
      score: z.number(),
      scannedAt: z.string(),
    })
    .optional(),
  /**
   * Provenance of an applied custom project type (see docs/project-types.md).
   * Distinct from `projectTypeId`, which is the taxonomy id used for craftbook
   * suggestion: a custom type stamps this on adoption and, when it `extends` a
   * taxonomy id, ALSO sets `projectTypeId` so detection-based suggestion
   * inherits. Absent on projects created without a custom type.
   */
  projectType: ProjectTypeProvenanceSchema.optional(),
  /**
   * Filesystem ownership boundary. Missing/`user` is ordinary per-account
   * state. `machine-shared` is a grandfathered project mounted from the
   * installer-managed shared root and operated on by this user's daemon.
   * The engine broker never opens the project or receives its paths.
   */
  storageScope: z.enum(['user', 'machine-shared']).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Project = z.infer<typeof ProjectSchema>;

/**
 * Resolve a project's effective type id: the explicit user override wins,
 * else the auto-detected type, else none. Shared by the craftbooks route and
 * the settings UI so "what type is this" is answered the same way everywhere.
 */
export function resolveProjectTypeId(project: {
  projectTypeId?: string;
  detectedProjectType?: { id: string };
}): string | undefined {
  return project.projectTypeId ?? project.detectedProjectType?.id;
}

/**
 * True when the project allows ambient (non-user-initiated) gezel work —
 * meester nudges, auto-phase-advance handoffs, cron ticks, boot-time
 * rehydration. Treats missing `status` as `active` for backwards
 * compatibility with every project on disk before this field existed.
 */
export function projectAllowsAmbientWork(project: {
  status?: 'active' | 'readonly' | 'inactive' | 'stable';
}): boolean {
  const status = project.status ?? 'active';
  // `stable` joins readonly/inactive here: a finished project gets no
  // ambient nudges. The difference is purely in how it's set/cleared
  // (automatic via the task lifecycle vs. a deliberate user choice) —
  // for the scheduler's purposes they're all "don't nudge."
  return status === 'active';
}

export const InstalledPackageSchema = z.object({
  name: z.string(),
  version: z.string(),
});
export type InstalledPackage = z.infer<typeof InstalledPackageSchema>;

export const ProjectDetailSchema = ProjectSchema.extend({
  packages: z.array(InstalledPackageSchema),
  /** Contents of `documents/about.md` inside the project, if present. */
  about: z.string().optional(),
  /** Contents of `documents/missionObjectives.md`, if present. */
  missionObjectives: z.string().optional(),
});
export type ProjectDetail = z.infer<typeof ProjectDetailSchema>;

export const ProjectFileEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  isDirectory: z.boolean(),
  /** File mtime (ms epoch). Populated only when the caller opts into stats. */
  mtimeMs: z.number().optional(),
});
export type ProjectFileEntry = z.infer<typeof ProjectFileEntrySchema>;

// ── Deprecated aliases — Git/GitHub naming realignment ──
/** @deprecated Use {@link ProjectGitHubSchema}. */
export const ProjectGithubSchema = ProjectGitHubSchema;
/** @deprecated Use {@link ProjectGitHub}. */
export type ProjectGithub = ProjectGitHub;
