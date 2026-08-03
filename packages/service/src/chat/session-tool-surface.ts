import {
  type ChatSession,
  type GezelConfig,
  type ProviderName,
  type ResolvedSecurityPolicy,
  type TaskCraftbookStep,
  isLocalProvider,
  normalizeScriptRefs,
  resolveRoleId,
} from '@bendyline/gezel';
import { BUILTIN_TOOLSETS } from '@bendyline/gezel-catalog';
import type { LocalModelTier } from './local-model-tier.js';
import {
  type WebSearchBackendName,
  computeToolAllowlist,
  constrainAllowlistForDirectFileWork,
  constrainAllowlistForExistingSourceEdit,
  constrainAllowlistForImmediateFileWrite,
  constrainAllowlistForImmediateNamedTool,
  constrainAllowlistForProjectRetrievalFirst,
  constrainAllowlistForScenarioFileRepair,
  isRoleDelegationTool,
  shouldConstrainToImmediateFileWrite,
} from './role-tool-filter.js';
import {
  capPriorityPrefixForKind,
  gateRepairToolsForKind,
  repairClampDisabled,
  stepGateRepairActive,
  stepToolKit,
  stepToolKitDisabled,
} from './step-tool-kit.js';
import type { AvailableToolInfo } from './tools-block.js';

export type SessionToolSurface = 'prompt' | 'bridge';
export type SessionToolClampKind =
  | 'project-orchestration'
  | 'project-retrieval-first'
  | 'immediate-named-tool'
  | 'immediate-file-write'
  | 'direct-file-work'
  | 'scenario-file-repair'
  | 'existing-source-edit'
  | 'gate-repair';

export interface ResolveSessionToolSurfaceOptions {
  surface: SessionToolSurface;
  session: ChatSession;
  role: string | undefined;
  mode: GezelConfig['toolFilterMode'];
  provider: ProviderName;
  modelId?: string;
  parameterSize?: string;
  toolsetsGroupOverride: readonly string[];
  projectMode?: 'crew' | 'solo';
  /**
   * Lean-agent profile (a game / chat-room project type). When true, the
   * builtin surface collapses to {@link LEAN_PROFILE_BUILTIN_TOOLS} — the
   * gezel's own script tools (make_move, get_board) still pass the bridge
   * filter because they aren't builtins, so the model sees only its game
   * tools plus `ask_user_question`, not the 60-tool developer workbench.
   */
  leanProfile?: boolean;
  consultationMode?: boolean;
  rolesAsTools?: boolean;
  webSearchProvider?: WebSearchBackendName;
  githubLinked: boolean;
  isGitRepo: boolean;
  securityPolicy?: ResolvedSecurityPolicy;
  /**
   * Effective per-project workspace writability (`projectWorkspaceWritable`
   * in core). `false` strips the `workspace-fs-write` group — the
   * per-project replacement for the old global `allowFileEdits` ceiling.
   */
  workspaceWritable?: boolean;
  tier: LocalModelTier | undefined;
  /**
   * Override the env-gated coordinator tool diet. Omit in production to use
   * `GEZEL_MEESTER_TOOL_DIET`; the static prompt matrix sets this explicitly
   * so it can exercise both medium/large surfaces deterministically.
   */
  coordinatorToolDiet?: boolean;
  latestUserMessage: string | undefined;
  /**
   * The persisted active craftbook step for a step-scoped session
   * (taskRef + stepId). Drives the deliverable-kind tool KIT (the
   * surface narrows to what this step's class + gate checks need) and
   * the gate-repair clamp derivation. Absent → no kit narrowing.
   */
  activeStep?: Pick<
    TaskCraftbookStep,
    | 'advanceWhen'
    | 'gate'
    | 'onExit'
    | 'completedAt'
    | 'gateAttempts'
    | 'lastGateReject'
    | 'gateAttemptHistory'
  >;
  /**
   * Deterministic tool invoked by a fixed-function session. Keep it through
   * role/step narrowing when it remains inside the mode=`never` hard ceiling
   * (security, repository, and configured-service gates still apply).
   */
  requiredTool?: string;
  forceDirectFileWork?: boolean;
  existingSubstantialFileForImmediate?: () => Promise<boolean>;
  onCapTrim?: (event: { before: number; after: number; dropped: string[] }) => void;
  onClamp?: (kind: SessionToolClampKind) => void;
}

export interface ResolvedSessionToolSurface {
  allowlist: Set<string> | null;
  projectOrchestrationConstrained: boolean;
}

/**
 * Materialize the built-in portion of a resolved allowlist exactly as the
 * cold-session prompt predictor does. Shared with the prompt-contract matrix
 * so CI exercises the production inventory and first-group-wins dedupe rules.
 */
export function availableBuiltinToolsForAllowlist(
  allowlist: ReadonlySet<string> | null,
): AvailableToolInfo[] {
  const predicted: AvailableToolInfo[] = [];
  const seenNames = new Set<string>();
  for (const group of BUILTIN_TOOLSETS) {
    for (const toolName of group.tools) {
      if (allowlist && !allowlist.has(toolName)) continue;
      if (seenNames.has(toolName)) continue;
      seenNames.add(toolName);
      predicted.push({ name: toolName, description: '' });
    }
  }
  return predicted;
}

/**
 * The only builtin tools a lean-profile gezel keeps. Its project-type
 * script tools (checkers' `make_move` / `get_board`) are NOT builtins, so
 * they pass the bridge's allowlist filter regardless and don't need listing
 * here — this is purely the essential builtin escape hatch.
 */
export const LEAN_PROFILE_BUILTIN_TOOLS: readonly string[] = ['ask_user_question'];

export async function resolveSessionToolSurface(
  opts: ResolveSessionToolSurfaceOptions,
): Promise<ResolvedSessionToolSurface> {
  const hasToolsetOverride = opts.toolsetsGroupOverride.length > 0;
  let rawAllowlist = computeToolAllowlist({
    role: opts.role,
    mode: opts.mode,
    provider: opts.provider,
    ...(opts.modelId !== undefined ? { modelId: opts.modelId } : {}),
    ...(opts.parameterSize !== undefined ? { parameterSize: opts.parameterSize } : {}),
    ...(hasToolsetOverride ? { toolsetsGroupOverride: opts.toolsetsGroupOverride } : {}),
    ...(opts.projectMode ? { projectMode: opts.projectMode } : {}),
    ...(opts.consultationMode ? { consultationMode: true } : {}),
    ...(opts.rolesAsTools ? { rolesAsTools: true } : {}),
    ...(opts.webSearchProvider ? { webSearchProvider: opts.webSearchProvider } : {}),
    githubLinked: opts.githubLinked,
    isGitRepo: opts.isGitRepo,
    ...(opts.securityPolicy ? { securityPolicy: opts.securityPolicy } : {}),
    ...(opts.workspaceWritable !== undefined ? { workspaceWritable: opts.workspaceWritable } : {}),
  });
  // The full surgical step-patch schema is intentionally absent from every
  // ordinary role kit. It is worth its ~18K compact schema characters only
  // in the explicit Craftbook editor, where the session is pinned to one
  // template and the editing prompt names it. Null already means unrestricted;
  // a concrete role/security allowlist needs this contextual grant.
  if (rawAllowlist && opts.session.craftbookRef) {
    rawAllowlist = new Set(rawAllowlist);
    rawAllowlist.add('craftbook_update_step');
  }
  // Lean-profile hard override: collapse the builtin surface to the minimal
  // essential set. Applied right after the role compute — a game session has
  // no task/step, so none of the step-completion / kit augmentation below
  // re-broadens it. The script tools ride through the bridge separately.
  if (opts.leanProfile) {
    rawAllowlist = new Set(LEAN_PROFILE_BUILTIN_TOOLS);
  }
  const requiredToolHardAllowed = opts.requiredTool
    ? (() => {
        const ceiling = computeToolAllowlist({
          role: opts.role,
          mode: 'never',
          provider: opts.provider,
          ...(opts.modelId !== undefined ? { modelId: opts.modelId } : {}),
          ...(opts.parameterSize !== undefined ? { parameterSize: opts.parameterSize } : {}),
          ...(opts.webSearchProvider ? { webSearchProvider: opts.webSearchProvider } : {}),
          githubLinked: opts.githubLinked,
          isGitRepo: opts.isGitRepo,
          ...(opts.securityPolicy ? { securityPolicy: opts.securityPolicy } : {}),
          ...(opts.workspaceWritable !== undefined
            ? { workspaceWritable: opts.workspaceWritable }
            : {}),
        });
        return ceiling === null || ceiling.has(opts.requiredTool!);
      })()
    : false;

  // A session actively executing a craftbook step must be able to finish
  // and hand it off — grant the task-progression tools even when the role's
  // default kit is read-only (a coordinator assigned a step). Applied
  // before the cap so the load-bearing floor protects them, and before the
  // narrowing constraints. Message-driven clamps may narrow the working
  // surface, but the completion tools are restored below so a seed that
  // mentions `write_file` can never hide the `write_task_note` action its
  // craftbook procedure requires first. Only augments a real filtered set;
  // a null allowlist already sees everything.
  if (rawAllowlist && opts.session.taskRef && opts.session.stepId) {
    const withStep = new Set(rawAllowlist);
    for (const name of STEP_COMPLETION_TOOLS) withStep.add(name);
    rawAllowlist = withStep;
  }

  // D4 step-scoped kit: the active step's deliverable class + gate
  // checks determine the working set; everything outside `kit ∪ floors`
  // drops. Narrows the MIDDLE only — the floors always survive — and
  // never fights an explicit toolset override or `mode: 'never'`.
  const kit =
    rawAllowlist &&
    opts.activeStep &&
    opts.session.taskRef &&
    opts.session.stepId &&
    opts.mode !== 'never' &&
    !hasToolsetOverride &&
    !stepToolKitDisabled()
      ? stepToolKit(opts.activeStep)
      : null;
  // Planner is a pure-delegation role in ordinary chat, but many authored
  // craftbooks deliberately assign it a planning document (`notes/*.md`,
  // an outline, a brief). In a real step-scoped session that assignment is
  // the authority to produce the Markdown deliverable. Grant only the
  // active Markdown kit, and only where the mode=`never` surface says each
  // tool survives the install's security + workspace-write ceilings.
  if (
    rawAllowlist &&
    kit &&
    resolveRoleId(opts.role) === 'planner' &&
    (kit.kind === 'markdown-doc' || kit.kind === 'markdown-report' || kit.kind === 'markdown-notes')
  ) {
    const hardCeiling = computeToolAllowlist({
      role: opts.role,
      mode: 'never',
      provider: opts.provider,
      ...(opts.modelId !== undefined ? { modelId: opts.modelId } : {}),
      ...(opts.parameterSize !== undefined ? { parameterSize: opts.parameterSize } : {}),
      ...(opts.webSearchProvider ? { webSearchProvider: opts.webSearchProvider } : {}),
      githubLinked: opts.githubLinked,
      isGitRepo: opts.isGitRepo,
      ...(opts.securityPolicy ? { securityPolicy: opts.securityPolicy } : {}),
      ...(opts.workspaceWritable !== undefined
        ? { workspaceWritable: opts.workspaceWritable }
        : {}),
    });
    const withPlannerDeliverable = new Set(rawAllowlist);
    for (const name of kit.tools) {
      if (hardCeiling === null || hardCeiling.has(name)) withPlannerDeliverable.add(name);
    }
    rawAllowlist = withPlannerDeliverable;
  }
  if (rawAllowlist && kit) {
    const keep = new Set<string>([
      ...kit.tools,
      ...STEP_COMPLETION_TOOLS,
      ...LOAD_BEARING_TOOL_CAP_ALWAYS_KEEP,
      ...SELF_CHECK_TOOL_CAP_ALWAYS_KEEP,
      'ask_user_question',
    ]);
    rawAllowlist = new Set([...rawAllowlist].filter((name) => keep.has(name)));
  }

  let allowlist = capToolAllowlistForTier({
    allowlist: rawAllowlist,
    tier: opts.tier,
    role: opts.role,
    mode: opts.mode,
    ...(kit ? { deliverableKind: kit.kind } : {}),
    ...(opts.rolesAsTools ? { rolesAsTools: true } : {}),
    ...(opts.coordinatorToolDiet !== undefined
      ? { coordinatorToolDiet: opts.coordinatorToolDiet }
      : {}),
    ...(opts.onCapTrim ? { onTrim: opts.onCapTrim } : {}),
  });

  const allowlistBeforeRetrievalFirst = allowlist;
  if (isLocalProvider(opts.provider)) {
    allowlist = constrainAllowlistForProjectRetrievalFirst(allowlist, {
      role: opts.role,
      latestUserMessage: opts.latestUserMessage,
      hasToolsetOverride,
      currentProjectId: opts.session.projectId,
    });
  }
  if (allowlist !== allowlistBeforeRetrievalFirst) opts.onClamp?.('project-retrieval-first');

  const projectOrchestrationConstrained = projectOrchestrationConstraintActive({
    record: opts.session,
    role: opts.role,
    provider: opts.provider,
    latestUserMessage: opts.latestUserMessage,
  });
  if (projectOrchestrationConstrained) {
    allowlist = constrainAllowlistForProjectOrchestration(allowlist, {
      soloJobOnly: projectOrchestrationPrefersSoloJob(opts.session, opts.latestUserMessage),
      ...(opts.rolesAsTools ? { rolesAsTools: true } : {}),
      suppressRoleDelegation: sessionContainsRemoteRepoIntakeRequest(
        opts.session,
        opts.latestUserMessage,
      ),
    });
    opts.onClamp?.('project-orchestration');
  }

  const allowlistBeforeNamedTool = allowlist;
  allowlist = constrainAllowlistForImmediateNamedTool(allowlist, opts.latestUserMessage);
  if (allowlist !== allowlistBeforeNamedTool) opts.onClamp?.('immediate-named-tool');

  const immediateOpts = {
    role: opts.role,
    latestUserMessage: opts.latestUserMessage,
    hasToolsetOverride,
  };
  const allowlistBeforeImmediate = allowlist;
  const immediateModify =
    shouldConstrainToImmediateFileWrite(immediateOpts) &&
    (await (opts.existingSubstantialFileForImmediate?.() ?? false));
  allowlist = constrainAllowlistForImmediateFileWrite(allowlist, {
    ...immediateOpts,
    existingSubstantialFile: immediateModify,
  });
  if (allowlist !== allowlistBeforeImmediate) opts.onClamp?.('immediate-file-write');

  const allowlistBeforeDirectFileWork = allowlist;
  allowlist = constrainAllowlistForDirectFileWork(allowlist, {
    role: opts.role,
    latestUserMessage: opts.latestUserMessage,
    hasToolsetOverride,
    force: opts.forceDirectFileWork,
  });
  if (allowlist !== allowlistBeforeDirectFileWork) opts.onClamp?.('direct-file-work');

  const allowlistBeforeRepair = allowlist;
  allowlist = constrainAllowlistForScenarioFileRepair(allowlist, {
    role: opts.role,
    latestUserMessage: opts.latestUserMessage,
    hasToolsetOverride,
  });
  if (allowlist !== allowlistBeforeRepair) opts.onClamp?.('scenario-file-repair');

  const allowlistBeforeSourceEdit = allowlist;
  allowlist = constrainAllowlistForExistingSourceEdit(allowlist, {
    role: opts.role,
    latestUserMessage: opts.latestUserMessage,
    hasToolsetOverride,
  });
  if (allowlist !== allowlistBeforeSourceEdit) opts.onClamp?.('existing-source-edit');

  // A message-shaped clamp is subordinate to the persisted craftbook
  // procedure. File handoffs commonly contain `write_file` wording even when
  // the active step explicitly requires `write_task_note` first. Restoring
  // the step-completion floor after every message-driven clamp keeps the
  // advertised schema consistent with that procedure while retaining the
  // clamp's useful reduction of unrelated tools. Only restore tools that
  // survived the role/security/step-kit ceiling in `rawAllowlist`.
  if (allowlist && rawAllowlist && opts.session.taskRef && opts.session.stepId) {
    const withStepCompletion = new Set(allowlist);
    for (const name of STEP_COMPLETION_TOOLS) {
      if (rawAllowlist.has(name)) withStepCompletion.add(name);
    }
    if (
      opts.activeStep &&
      normalizeScriptRefs(opts.activeStep.onExit).length > 0 &&
      rawAllowlist.has('run_installed_script')
    ) {
      withStepCompletion.add('run_installed_script');
    }
    allowlist = withStepCompletion;
  }

  // D4 clamp lifetime: a gate rejected this session's deliverable and
  // the validator has not approved since — force the repair clamp
  // REGARDLESS of the current message's markers (the five clamps above
  // are marker-driven and the first rejections carry no marker, which
  // is the widen-back bug). Persisted gate state drives it; approve /
  // step completion clears it structurally.
  if (
    allowlist &&
    !hasToolsetOverride &&
    opts.mode !== 'never' &&
    !repairClampDisabled() &&
    stepGateRepairActive(opts.activeStep, opts.session)
  ) {
    const repairKeep = new Set<string>([
      ...gateRepairToolsForKind(kit?.kind ?? null),
      ...STEP_COMPLETION_TOOLS,
      ...LOAD_BEARING_TOOL_CAP_ALWAYS_KEEP,
      ...SELF_CHECK_TOOL_CAP_ALWAYS_KEEP,
      'ask_user_question',
      ...(opts.activeStep && normalizeScriptRefs(opts.activeStep.onExit).length > 0
        ? ['run_installed_script']
        : []),
    ]);
    const clamped = new Set([...allowlist].filter((name) => repairKeep.has(name)));
    // Starvation guard: only apply when the clamped surface still
    // carries a mutation tool — a role whose kit has no write access
    // (mis-assignment) is fixed by reassignment, not by starving.
    // `write_artifact` counts only when the drawer is where the repair
    // must land: an artifact-flagged deliverable, or a writes-off
    // project where the drawer is the one remaining write channel. A
    // read-only-workspace role facing a workspace deliverable still
    // skips — drawer access can't fix that file.
    const MUTATION_TOOLS = [
      'write_file',
      'append_to_file',
      'replace_in_file',
      'replace_lines',
      'apply_patch',
      'derive_file',
    ];
    const drawerIsRepairChannel =
      opts.activeStep?.advanceWhen?.artifact === true || opts.workspaceWritable === false;
    if (
      MUTATION_TOOLS.some((name) => clamped.has(name)) ||
      (drawerIsRepairChannel && clamped.has('write_artifact'))
    ) {
      // Fire even when the kit already narrowed to the same set — the
      // clamp being IN EFFECT is the telemetry signal, not the delta.
      allowlist = clamped;
      opts.onClamp?.('gate-repair');
    }
  }

  if (allowlist && opts.requiredTool && requiredToolHardAllowed) {
    allowlist = new Set(allowlist);
    allowlist.add(opts.requiredTool);
  }

  return { allowlist, projectOrchestrationConstrained };
}

const MEESTER_PROJECT_ORCHESTRATION_TOOLS = [
  'start_job',
  'start_project',
  'fetch_repo',
  'fetch_diff',
  'list_projects',
  'list_gezels',
  'ensure_gezel',
  'message_gezel',
  // Exact-format production should enter its bundled procedure instead of
  // falling back to ad-hoc task creation or markdown. These two are the
  // compact front door; the invoked task carries the rest of the workflow.
  'suggest_craftbook',
  'invoke_craftbook',
  'search_memory',
  'save_memory',
  'search_history',
  'search_sessions',
] as const;

const MEESTER_SOLO_PROJECT_JOB_TOOLS = [
  'start_job',
  'search_memory',
  'save_memory',
  'search_history',
  'search_sessions',
] as const;

// Self-check tools exempt from the per-tier tool-cap, kept for every role and
// tier. `validate` is a pure read-only "check my file before I declare done"
// gate (parses HTML/JS/TS/JSON, image magic-bytes, etc.); it lives in the
// always-registered MCP inventory. Without this it can fall below a tier cut
// for meester/voorman, so a model that tries to self-verify gets
// back "unknown tool validate" and loops. Wild-caught
// (qwen3.5-2b on bookstore-openapi). Self-verify-before-done helps any
// iterate-to-correct task, so exempting it is not scenario-specific. Extend
// only with tools that are similarly read-only and broadly useful.
export const SELF_CHECK_TOOL_CAP_ALWAYS_KEEP = new Set<string>(['validate']);

// Load-bearing tools that survive a tier count-cap unconditionally
// when present on the surface — the "make progress on your assigned step"
// set. A session must never be trimmed below the ability to read its step
// context, record a note, mark status, and hand off; nor below writing the
// deliverable when it can. Same exemption mechanism as
// SELF_CHECK_TOOL_CAP_ALWAYS_KEEP. Kept as an explicit floor so a future cap
// change can't silently reintroduce the evict-the-load-bearing-tool failure
// class (the imara office-hours kickoff loop,, where
// `read_task_notes` was ranked below the cut and `list_projects` above it).
const LOAD_BEARING_TOOL_CAP_ALWAYS_KEEP: ReadonlySet<string> = new Set([
  'read_task_notes',
  'write_task_note',
  'advance_task_step',
  'set_task_status',
  'write_file',
  // Delegation-role task procedures and role templates use this as the
  // name-addressed handoff escape hatch. Tiny-tier caps previously evicted
  // it from Planner while the active step still said "use message_gezel".
  'message_gezel',
  // Universal prompt contract: every role is told to use the structured
  // question card for a genuine human decision. A tier cap must not evict
  // the tool while leaving that standing directive behind.
  'ask_user_question',
]);

// Task-progression tools granted to any session actively executing a
// craftbook step (`taskRef` + `stepId` set), regardless of role. The
// assignee of a step must be able to record progress and hand off — even a
// coordinator whose default kit is read-only. "Mutation lives with the
// assignee," and a step-scoped session IS the assignee. Wild-caught (imara
// office-hours kickoff): a Meester was handed the `kickoff` step
// of an office-hours craftbook, but the meester role kit is `tasks-readonly`
// (no `write_task_note` / `advance_task_step`). The nudge told her to write
// the deliverable and advance; neither tool was on her surface, so she
// stalled. `write_file` is deliberately absent from this generic grant. The
// narrow Planner + Markdown exception is derived from the active step kit
// above; source-file misassignment still requires reassignment.
const STEP_COMPLETION_TOOLS: readonly string[] = [
  'read_task_notes',
  'write_task_note',
  'advance_task_step',
  'set_task_status',
];

const MEESTER_TOOL_CAP_PRIORITY = [
  'start_job',
  'start_project',
  'fetch_repo',
  'fetch_diff',
  'ask_user_question',
  'list_projects',
  'list_gezels',
  'ensure_gezel',
  'message_gezel',
  // The craftbook front door. The meester's V2 duty at task creation is
  // find-or-author: rank the library (suggest), run a match (invoke), or
  // author/edit a book as one document (read/write). These MUST survive
  // the constrained-tier cap — previously they weren't in this
  // list at all, so on medium local models (qwen3.6-27b) the ENTIRE
  // craftbook surface was evicted from the very gezel meant to use it:
  // the model truthfully reported "I don't have craftbook_write" and
  // fell back to delegating ad-hoc file work.
  'suggest_craftbook',
  'invoke_craftbook',
  'craftbook_read',
  'craftbook_write',
  'list_gilde',
  'create_gezel',
  'update_gezel',
  'ask_specialist',
  'ask_gezel',
  'update_project',
  'list_project_gezels',
  'add_gezel_to_project',
  'remove_gezel_from_project',
  'list_tasks',
  'get_task',
  'read_task_notes',
  'search_memory',
  'save_memory',
  'search_history',
  'search_sessions',
  'list_artifacts',
  'read_artifact',
  'write_artifact',
  // Tail of the curated list: reached at small tier (cap == list length),
  // truncated away at tiny. `craftbook_read`'s own argument description
  // reads "Craftbook id from list_craftbooks", so dropping this left the
  // schema pointing at a tool the one craftbook-centric role couldn't see.
  'list_craftbooks',
  //
  // Deliberately NOT curated here, so the small-tier trim is a decision
  // rather than an omission:
  //   - `craftbook_add_step` / `craftbook_remove_step` /
  //     `craftbook_reorder_steps` / `set_step_deliverable` — redundant with
  //     the curated `craftbook_read` + `craftbook_write` whole-document
  //     path, which is the edit route the meester is actually taught.
  //   - `list_suggested_work` / `enable_suggested_work` /
  //     `disable_suggested_work` — a settings-shaped side surface; nothing
  //     in the prompt stack names them, so their absence creates no
  //     prompt-vs-runtime drift, and three more schemas is real prefill on
  //     a 8B.
  //   - the document search/intel tail (`search_documents`, `search_docs`,
  //     `read_doc_as_markdown`, `find_entity`, …) — `search_memory` and
  //     `read_document` cover recall for a coordinator that delegates the
  //     reading work anyway.
  // Revisit any of these by adding the name here; the cap follows the list
  // length, so curating a tool in never squeezes another one out.
] as const;

const VOORMAN_TOOL_CAP_PRIORITY = [
  // Delegation surface: the voorman's primary job.
  'message_gezel',
  'ensure_gezel',
  'ask_specialist',
  'list_gezels',
  // Full task lifecycle: see -> note -> create -> assign -> advance -> CLOSE.
  // `set_task_status` + `advance_task_step` are load-bearing and MUST survive
  // the medium-tier cap: the voorman's system prompt instructs her to advance
  // and close tasks when shipped.
  'list_tasks',
  'get_task',
  'read_task_notes',
  'write_task_note',
  'create_task',
  'assign_task',
  'set_task_status',
  'advance_task_step',
  // Multi-file / multi-phase work runs through a craftbook. These are the
  // voorman's primary tools for that path — including whole-document
  // read/edit of a running task's book (fix a failing step's prompt, add
  // a verification step) via craftbook_read/craftbook_write.
  'suggest_craftbook',
  'invoke_craftbook',
  'craftbook_read',
  'craftbook_write',
  // Verify delegated deliverables actually landed before reporting done.
  'read_file',
  'list_dir',
  // Handoff briefs / scratch.
  'list_artifacts',
  'read_artifact',
  'write_artifact',
  // The voorman owns the project record: status, about/mission edits, voorman
  // reassignment.
  'update_project',
  // --- below here trimmed at the small-tier cap ---
  'search_sessions',
  'list_craftbooks',
  'list_project_gezels',
  'list_projects',
  'stat',
  'validate',
  'search_files',
  'find_files',
  'diff_files',
  'grep_artifact',
  'add_gezel_to_project',
  'remove_gezel_from_project',
  'add_task_step',
  'update_task',
] as const;

const IMPLEMENTATION_TOOL_CAP_PRIORITY = [
  'write_file',
  'append_to_file',
  'replace_lines',
  'replace_in_file',
  'read_file',
  'list_dir',
  'stat',
  'validate',
  'run_nodejs_script',
  'derive_file',
  'apply_patch',
  'insert_at_marker',
  'make_dir',
  'delete_path',
  'rename',
  'list_package_scripts',
  'run_package_script',
  'run_npx',
  'npm_install',
  'list_tasks',
  'get_task',
  'read_task_notes',
  'write_task_note',
  'set_task_status',
  'advance_task_step',
] as const;

// Ranking for the slots that remain after a role's curated priority list is
// exhausted — and the entire ranking for a role that has no curated list
// (any custom role at tiny tier). Previously these slots were filled by
// `Set` iteration order, i.e. whichever toolset group happened to insert
// first: the surviving surface silently depended on group ordering rather
// than on any judgement about what a trimmed session needs. A generalist
// read-then-write ladder is the considered answer — inspect, search, then
// the artifact drawer and recall — with the actual mutation tools already
// guaranteed by LOAD_BEARING_TOOL_CAP_ALWAYS_KEEP regardless of rank.
// Anything past this list is filled alphabetically, so the outcome is a
// function of the surface alone, never of iteration order.
const GENERIC_TOOL_CAP_FALLBACK: readonly string[] = [
  'read_file',
  'list_dir',
  'stat',
  'search_files',
  'find_files',
  'list_artifacts',
  'read_artifact',
  'write_artifact',
  'search_memory',
  'save_memory',
  'list_memories',
  'list_documents',
  'read_document',
  'list_tasks',
  'get_task',
  'ask_specialist',
];

function isImplementationRole(role: string | undefined): boolean {
  const normalized = role?.toLowerCase().trim() ?? '';
  return (
    normalized.includes('builder') ||
    normalized.includes('developer') ||
    normalized.includes('engineer') ||
    normalized.includes('programmer') ||
    normalized.includes('coder')
  );
}

export function toolCapForTierAndRole(
  tier: LocalModelTier | undefined,
  role: string | undefined,
  opts?: { coordinatorToolDiet?: boolean },
): number | null {
  // Count-capping applies broadly at tiny tier. On tiny local models (sub-5B)
  // the full tool-schema prefill measurably stalls first-token, so a hard
  // ceiling earns its keep there. At larger tiers the schema-size cost is
  // primarily handled by `mcp.compact-tool-schemas` (~15K tokens on a full
  // surface). Historical caps BELOW the complete curated orchestration list
  // repeatedly rendered coordinator gezels inoperable by evicting
  // load-bearing tools while keeping incidental reads. Canonical case (imara
  // office-hours kickoff): a
  // medium 12B Meester capped at 13 looped `list_projects` (priority rank
  // 6) because `read_task_notes` (rank 26) had been trimmed out from under
  // the "resume via read_task_notes" prompt. The old hand-tuned per-role
  // table (meester 13, voorman 22/80, unknown 30/40 across small+medium)
  // was the maintenance treadmill that kept producing these incidents. See
  // docs/prompt-stack.md "Tool-surface budget".
  if (tier === 'tiny') {
    // Implementation roles need a broad workbench even on tiny; keep only a
    // high sanity ceiling for pathological toolset stacks.
    if (isImplementationRole(role)) return 75;
    // Every other role (meester, voorman, custom) shares the tiny ceiling.
    // The load-bearing floor (LOAD_BEARING_TOOL_CAP_ALWAYS_KEEP) guarantees
    // the step-progression tools survive regardless of this count, so the
    // cap can shed schema weight without ever trimming a session below the
    // ability to finish its assigned step.
    return 15;
  }
  // Small-tier coordinators: cap AT the curated orchestration list length
  // by default (meester 34, voorman 38). Wild-caught (petshop,
  // qwen3.5-9b-q4): the uncapped 161-tool surface produced a ~36k-token
  // first prompt on a 9B; the meester streamed 0 visible chars for 9
  // minutes and the llama-cpp mid-stream watchdog aborted the kickoff
  // turn. Capping at the list length keeps EVERY curated tool (the imara
  // incident above came from capping BELOW list length), sheds only the
  // uncurated workspace/execution/browser tail. Implementation roles keep
  // full breadth — their workbench is the job.
  if (tier === 'small') {
    return coordinatorPriorityLength(role);
  }
  // Theme F (perf / do-less-work): the meester + voorman get the FULL
  // ~161-tool surface UNCAPPED at every tier above small today, and tool
  // schemas dominate local prompt mass (~12.8K tok ≈ 3.5× all standing
  // text). At medium/large, cap coordinator sessions to their curated
  // orchestration priority-list length — dropping the ~127 workspace/
  // execution/browser tools while keeping EVERY curated tool, crucially
  // `read_task_notes` (rank ~26), whose trimming under the old cap-of-13
  // broke a 12B meester (the incident above). Capping AT the list length
  // (never below it) is exactly what makes that safe. Keep this opt-in:
  // medium/large roles are documented as receiving their full kit, and
  // coordinator priority lists drift whenever new task/craftbook tools land.
  // GEZEL_MEESTER_TOOL_DIET=1 remains available for targeted prompt-cost
  // experiments without silently weakening the production coordinator kit.
  if (tier === 'medium' || tier === 'large') {
    const diet = coordinatorToolDietCap(role, opts?.coordinatorToolDiet);
    if (diet !== null) return diet;
  }
  // cloud / non-coordinator small+medium+large: uncapped — schema cost
  // is handled by `mcp.compact-tool-schemas`.
  return null;
}

/**
 * The coordinator tool-diet cap (Theme F): the length of the role's
 * curated orchestration priority list, or `null` when the diet is off or
 * the role isn't a coordinator. Capping at the list length keeps every
 * curated tool (so the resume/orchestration surface — `read_task_notes`,
 * `list_tasks`, `start_job`… — always survives) and drops only the
 * uncurated tail. The `capToolAllowlist` priority ordering
 * (`MEESTER_TOOL_CAP_PRIORITY`/`VOORMAN_TOOL_CAP_PRIORITY`) plus the
 * always-keep load-bearing floor do the rest.
 */
function coordinatorToolDietCap(
  role: string | undefined,
  enabledOverride?: boolean,
): number | null {
  const enabled = enabledOverride ?? process.env.GEZEL_MEESTER_TOOL_DIET === '1';
  if (!enabled) return null;
  return coordinatorPriorityLength(role);
}

/** Curated orchestration-list length for coordinator roles, else null. */
function coordinatorPriorityLength(role: string | undefined): number | null {
  const normalized = role?.toLowerCase().trim() ?? '';
  if (normalized.includes('voorman') || normalized.includes('foreman')) {
    return VOORMAN_TOOL_CAP_PRIORITY.length;
  }
  if (normalized.includes('meester')) return MEESTER_TOOL_CAP_PRIORITY.length;
  return null;
}

function toolCapPriorityForRole(
  role: string | undefined,
  deliverableKind?: import('@bendyline/gezel').DeliverableKind,
): readonly string[] {
  const normalized = role?.toLowerCase().trim() ?? '';
  const base = normalized.includes('meester')
    ? MEESTER_TOOL_CAP_PRIORITY
    : normalized.includes('voorman') || normalized.includes('foreman')
      ? VOORMAN_TOOL_CAP_PRIORITY
      : isImplementationRole(role)
        ? IMPLEMENTATION_TOOL_CAP_PRIORITY
        : [];
  // Deliverable-aware prefix: the active step's producing tools rank
  // first so the tiny cap never trims them in favor of generic breadth
  // (e.g. derive_file ranked 10th would fall below a 15-tool cut on a
  // data step).
  const prefix = capPriorityPrefixForKind(deliverableKind ?? null);
  if (prefix.length === 0) return base;
  const seen = new Set(prefix);
  return [...prefix, ...base.filter((name) => !seen.has(name))];
}

function capToolAllowlistForTier(opts: {
  allowlist: Set<string> | null;
  tier: LocalModelTier | undefined;
  role: string | undefined;
  /**
   * When the `tools.gezels-as-roles` behavior is active, exempt the
   * role-delegation tools from the cap (the cap still trims the rest of
   * the surface identically to control).
   */
  rolesAsTools?: boolean;
  /** Active step's deliverable class — prepends a kit prefix to the priority list. */
  deliverableKind?: import('@bendyline/gezel').DeliverableKind;
  /** Explicit matrix/test override for the env-gated coordinator diet. */
  coordinatorToolDiet?: boolean;
  /**
   * Active `toolFilterMode`. When `'never'` the user explicitly opted out of
   * role-based reduction, so the count cap is skipped even when gates produce
   * a non-null allowlist.
   */
  mode?: GezelConfig['toolFilterMode'];
  onTrim?: (event: { before: number; after: number; dropped: string[] }) => void;
}): Set<string> | null {
  if (!opts.allowlist) return null;
  if (opts.mode === 'never') return opts.allowlist;
  const cap = toolCapForTierAndRole(opts.tier, opts.role, {
    ...(opts.coordinatorToolDiet !== undefined
      ? { coordinatorToolDiet: opts.coordinatorToolDiet }
      : {}),
  });
  if (cap === null) return opts.allowlist;
  const alwaysKeep = (name: string): boolean =>
    SELF_CHECK_TOOL_CAP_ALWAYS_KEEP.has(name) ||
    LOAD_BEARING_TOOL_CAP_ALWAYS_KEEP.has(name) ||
    (opts.rolesAsTools === true && isRoleDelegationTool(name));
  const nonExempt = [...opts.allowlist].filter((n) => !alwaysKeep(n)).length;
  if (nonExempt <= cap) return opts.allowlist;
  const trimmed = capToolAllowlist({
    allowlist: opts.allowlist,
    cap,
    role: opts.role,
    ...(opts.deliverableKind ? { deliverableKind: opts.deliverableKind } : {}),
    alwaysKeep,
  });
  const dropped = [...opts.allowlist].filter((name) => !trimmed.has(name));
  opts.onTrim?.({ before: opts.allowlist.size, after: trimmed.size, dropped });
  return trimmed;
}

export function buildToolCapWarning(opts: {
  tier: LocalModelTier | undefined;
  role: string | undefined;
  before: number;
  after: number;
  dropped: readonly string[];
}): string {
  const tier = opts.tier ?? 'unknown';
  const role = opts.role?.trim() || 'this gezel';
  const visibleDropped = opts.dropped.slice(0, 8);
  const hiddenCount = opts.dropped.length - visibleDropped.length;
  const sample =
    visibleDropped.length > 0
      ? ` Hidden tools include: ${visibleDropped.map((name) => `\`${name}\``).join(', ')}${
          hiddenCount > 0 ? `, and ${hiddenCount} more` : ''
        }.`
      : '';
  return `Tool cap trimmed this ${tier}-tier ${role} session from ${opts.before} to ${opts.after} tools.${sample} If the gezel seems confused or unable to use an expected tool, use a larger model or reduce the installed toolsets.`;
}

function shouldConstrainToProjectOrchestration(opts: {
  role: string | undefined;
  provider: ProviderName;
  latestUserMessage: string | undefined;
}): boolean {
  if (!isLocalProvider(opts.provider)) return false;
  const normalizedRole = opts.role?.toLowerCase().trim() ?? '';
  if (!normalizedRole.includes('meester') && !normalizedRole.includes('voorman')) return false;
  const text = opts.latestUserMessage?.toLowerCase() ?? '';
  if (!text.trim()) return false;
  // Procedure/recipe asks have their own Meester prelude and tool surface.
  // Without this precedence, "create a reusable weekly procedure for
  // reviewing project quality" matched create + project here, clamped the
  // roster to kickoff macros, then the craftbook prelude instructed
  // craftbook_read/craftbook_write calls that the clamp had just removed.
  if (
    /\b(?:recipe|craftbook|playbook|runbook|checklist|routine|reusable|repeatable|recurring|weekly|monthly|procedure|workflow)\b/i.test(
      text,
    )
  ) {
    return false;
  }
  const asksForBuild = /\b(?:build|create|make|develop|implement|prototype|ship)\b/i.test(text);
  const namesDeliverable =
    /\b(?:project|game|app|application|website|site|dashboard|tool|prototype|html|browser|powerpoint|presentation|slide\s*deck|slides?|document|report|pdf|docx|pptx|xlsx|spreadsheet)\b/i.test(
      text,
    );
  return asksForBuild && namesDeliverable;
}

function isRemoteRepoIntakeRequest(text: string | undefined): boolean {
  const normalized = text ?? '';
  if (!normalized.trim()) return false;
  const hasRemoteRepo =
    /https?:\/\/(?:github\.com|gitlab\.com|bitbucket\.org)\/[^\s)"'`<>]+/i.test(normalized) ||
    /https?:\/\/[^\s)"'`<>]+\.git(?:\b|[/?#])/i.test(normalized) ||
    /\bfetch_repo\s*\(/i.test(normalized) ||
    /\bfetch_diff\s*\(/i.test(normalized);
  if (!hasRemoteRepo) return false;
  return /\b(?:repo|repository|github|gitlab|bitbucket|clone|fetch_repo|fetch_diff|review|audit|analy[sz]e|analysis|inspect|codebase|source|diff|pull request|pr)\b/i.test(
    normalized,
  );
}

function sessionContainsRemoteRepoIntakeRequest(
  record: ChatSession,
  latestUserMessage: string | undefined,
): boolean {
  const candidates = [
    latestUserMessage,
    record.title,
    ...record.messages
      .filter((message) => message.role === 'user')
      .map((message) => message.content),
  ];
  return candidates.some((text) => isRemoteRepoIntakeRequest(text));
}

function isProjectOrchestrationContinuation(text: string | undefined): boolean {
  const normalized = text?.trim() ?? '';
  if (!normalized) return false;
  return (
    /^\[(?:Message from|Question from|Answer from|Answer to) [^\]]+\]:/i.test(normalized) ||
    /^\[Answer to:/i.test(normalized) ||
    /^\[scenario coordinator copy\]/i.test(normalized) ||
    /\[Deliverable expected as a FILE at `[^`]+`\]/i.test(normalized) ||
    /\b(?:wrote|created|updated|patched|fixed)\s+`?index\.html`?\b/i.test(normalized)
  );
}

function sessionContainsProjectBuildRequest(
  record: ChatSession,
  opts: {
    role: string | undefined;
    provider: ProviderName;
  },
): boolean {
  if (
    shouldConstrainToProjectOrchestration({
      ...opts,
      latestUserMessage: record.title,
    })
  ) {
    return true;
  }
  return record.messages.some((message) => {
    if (message.role !== 'user') return false;
    const text = typeof message.content === 'string' ? message.content : '';
    return shouldConstrainToProjectOrchestration({
      ...opts,
      latestUserMessage: text,
    });
  });
}

export function projectOrchestrationConstraintActive(opts: {
  record: ChatSession;
  role: string | undefined;
  provider: ProviderName;
  latestUserMessage: string | undefined;
}): boolean {
  const normalizedRole = opts.role?.toLowerCase().trim() ?? '';
  if (
    normalizedRole.includes('meester') &&
    isLocalProvider(opts.provider) &&
    sessionContainsRemoteRepoIntakeRequest(opts.record, opts.latestUserMessage)
  ) {
    return true;
  }
  if (
    shouldConstrainToProjectOrchestration({
      role: opts.role,
      provider: opts.provider,
      latestUserMessage: opts.latestUserMessage,
    })
  ) {
    return true;
  }
  if (!isProjectOrchestrationContinuation(opts.latestUserMessage)) return false;
  return sessionContainsProjectBuildRequest(opts.record, {
    role: opts.role,
    provider: opts.provider,
  });
}

function constrainAllowlistForProjectOrchestration(
  allowlist: Set<string> | null,
  opts?: { soloJobOnly?: boolean; rolesAsTools?: boolean; suppressRoleDelegation?: boolean },
): Set<string> {
  const projectTools = opts?.soloJobOnly
    ? MEESTER_SOLO_PROJECT_JOB_TOOLS
    : MEESTER_PROJECT_ORCHESTRATION_TOOLS;
  if (!allowlist) return new Set(projectTools);
  const constrained = new Set<string>();
  for (const tool of projectTools) {
    if (allowlist.has(tool)) constrained.add(tool);
  }
  // When role tools are active, the meester delegates via delegate_<role>
  // instead of message_gezel/ensure_gezel. Keep them through the constraint
  // unless a remote-repo intake turn needs the fixed repo-fetch surface.
  if (opts?.rolesAsTools && !opts.suppressRoleDelegation) {
    for (const tool of allowlist) {
      if (isRoleDelegationTool(tool)) constrained.add(tool);
    }
  }
  return constrained;
}

function projectOrchestrationPrefersSoloJob(
  record: ChatSession,
  latestUserMessage: string | undefined,
): boolean {
  const candidates = [
    latestUserMessage,
    record.title,
    ...record.messages
      .filter((message) => message.role === 'user')
      .map((message) => message.content),
  ];
  return candidates.some((text) => isSingleSpecialistDeliverableRequest(text));
}

function isSingleSpecialistDeliverableRequest(text: string | undefined): boolean {
  const normalized = text?.toLowerCase() ?? '';
  if (!normalized.trim()) return false;
  const asksForMultidiscipline =
    /\b(?:logo|image|illustration|photo|video|audio|research|docs?|tests?)\b/i.test(normalized) &&
    /\band\b/i.test(normalized);
  if (asksForMultidiscipline) return false;
  return (
    /\b(?:quick prototype|one-shot|just for me)\b/i.test(normalized) ||
    /\bsingle[-\s]?(?:file|html)\b/i.test(normalized) ||
    /\bone[-\s]?file\b/i.test(normalized) ||
    /\bno build step\b/i.test(normalized) ||
    /\ball in (?:one )?`?index\.html`?\b/i.test(normalized) ||
    /\bworkspace\/index\.html\b/i.test(normalized) ||
    /\bindex\.html\b/i.test(normalized)
  );
}

function capToolAllowlist(opts: {
  allowlist: Set<string>;
  cap: number;
  role: string | undefined;
  deliverableKind?: import('@bendyline/gezel').DeliverableKind;
  /**
   * Tools to retain unconditionally, exempt from the cap.
   */
  alwaysKeep?: (name: string) => boolean;
}): Set<string> {
  const alwaysKeep = opts.alwaysKeep ?? (() => false);
  const result = new Set<string>();
  for (const name of opts.allowlist) {
    if (alwaysKeep(name)) result.add(name);
  }
  const priority = toolCapPriorityForRole(opts.role, opts.deliverableKind);
  let nonExempt = 0;
  const tryAdd = (name: string): boolean => {
    if (alwaysKeep(name) || result.has(name)) return true;
    if (nonExempt >= opts.cap) return false;
    result.add(name);
    nonExempt++;
    return true;
  };
  for (const name of priority) {
    if (!opts.allowlist.has(name)) continue;
    if (nonExempt >= opts.cap) break;
    tryAdd(name);
  }
  const ranked = new Set(priority);
  const fill = [
    ...GENERIC_TOOL_CAP_FALLBACK.filter((name) => !ranked.has(name)),
    ...[...opts.allowlist]
      .filter((name) => !ranked.has(name) && !GENERIC_TOOL_CAP_FALLBACK.includes(name))
      .sort(),
  ];
  for (const name of fill) {
    if (!opts.allowlist.has(name)) continue;
    if (nonExempt >= opts.cap) break;
    tryAdd(name);
  }
  return result;
}
