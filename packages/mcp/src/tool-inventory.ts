/**
 * Frozen inventory of every MCP tool the gezel-mcp server registers.
 *
 * This list is the contract between gezels (their prompts, especially the
 * Meester's, teach specific tool names), the OpenAI provider's `mcp-bridge`
 * (which translates these into OpenAI function-tool shape), and the on-disk
 * gezel state the tools mutate.
 *
 * Adding a tool? Append its name here and `inventory.test.ts` will pass.
 * Renaming or removing a tool? Update this list in the same change so the
 * test doesn't lie about the surface.
 *
 * Tools grouped only as a reading aid — the order doesn't matter to the
 * test; the test compares as a set.
 *
 * Project-type script tools (`GEZEL_SCRIPT_TOOLS`, see script-tools.ts)
 * are deliberately NOT listed: they're per-project dynamic registrations
 * whose names come from the applied type's manifest, not from this frozen
 * contract. Registration guards them against colliding with these names.
 */

export const ALWAYS_REGISTERED_TOOLS = [
  // Memory
  'search_memory',
  'save_memory',
  'list_memories',

  // Workspace (read-write project files)
  'list_dir',
  'read_file',
  'read_files',
  'stat',
  'write_file',
  'append_to_file',
  'replace_in_file',
  'replace_lines',
  'apply_patch',
  'insert_at_marker',
  'delete_path',
  'make_dir',
  'rename',
  'copy_artifact_to_workspace',
  'validate',

  // Execution (Node / npm / playwright)
  'npm_install',
  'list_package_scripts',
  'run_package_script',
  'run_npx',
  'run_nodejs_script',
  'derive_file',
  'list_packages',
  'run_playwright_script',

  // Artifacts (project-scoped)
  'list_artifacts',
  'read_artifact',
  'write_artifact',
  'grep_artifact',
  'browser_find_page_element',

  // Documents (shared library)
  'list_documents',
  'read_document',
  'write_document',
  'delete_document',
  'search_documents',

  // Team / gezels
  'list_gezels',
  'create_gezel',
  'list_gilde',
  'list_project_types',
  'apply_project_type',
  'start_project_from_type',
  'export_ai_app',
  'import_ai_app',
  'ensure_gezel',
  'update_gezel',
  'message_gezel',
  'ask_gezel',
  'ask_specialist',

  // Role-typed delegation (always registered; surfaced per session only
  // when the `tools.gezels-as-roles` behavior is active — see
  // role-tool-filter.ts + builtin-toolsets.ts `role-delegation*` groups).
  'delegate_developer',
  'consult_developer',
  'delegate_designer',
  'consult_designer',
  'delegate_reviewer',
  'consult_reviewer',
  'delegate_planner',
  'consult_planner',
  'delegate_researcher',
  'consult_researcher',
  'delegate_builder',
  'consult_builder',
  'delegate_writer',
  'consult_writer',
  'delegate_image_generator',
  'consult_image_generator',
  'delegate_voorman',
  'consult_voorman',
  'delegate_meester',
  'consult_meester',

  // User
  'ask_user_question',

  // Projects
  'list_projects',
  'start_project',
  'fetch_repo',
  'fetch_diff',
  'update_project',
  'list_project_gezels',
  'add_gezel_to_project',
  'remove_gezel_from_project',
  'list_suggested_work',
  'enable_suggested_work',
  'disable_suggested_work',

  // Tasks
  'list_tasks',
  'get_task',
  'create_task',
  'start_plan',
  'update_task',
  'set_outcomes',
  'verify_outcome',
  'add_verification_step',
  'spawn_task_instances',
  'list_task_children',
  'set_task_status',
  'activate_task',
  'assign_task',
  'add_task_step',
  'advance_task_step',
  'read_task_notes',
  'write_task_note',

  // History
  'search_history',
  'search_sessions',

  // Handboek (built-in documentation)
  'how_do_i',

  // Images
  'render_image',
  'generate_image',
  'describe_image',
  'read_image_metadata',

  // Video
  'generate_video',

  // Audio (whisper.cpp STT + Kokoro TTS)
  'transcribe_audio',
  'synthesize_speech',

  // Web
  'fetch_url',
  'web_search',
  'wikipedia_search',
  'wikipedia_read',

  // Search / files
  'search',
  'grep_files',
  'find_files',
  'diff_files',
  'read_image_as_base64',

  // Code intelligence (workspace content index)
  'outline_file',
  'find_symbol',
  'read_symbol',
  'find_references',
  'map_repo',
  'search_code',
  'file_review',
  'list_file_issues',
  'get_file_issue',
  'set_file_issue_status',

  // Security intelligence (static security analysis over the index)
  'security_scan',
  'security_overview',
  'scan_findings',
  'map_attack_surface',
  'list_dependencies',
  'trace_taint',

  // Document intelligence (converted office docs)
  'search_docs',
  'read_doc_as_markdown',

  // Image intelligence (workspace image library)
  'search_images',
  'find_similar_images',
  'describe_folder',

  // Entity intelligence (meta-boekwachter: cross-file entities)
  'find_entity',
  'list_entity_mentions',

  // Archives
  'list_archive',
  'extract_archive',

  // Git
  'run_git',

  // Scripts
  'list_scripts',
  'run_installed_script',
  'get_script_run',

  // Craftbooks (procedures)
  'list_craftbooks',
  'suggest_craftbook',
  'invoke_craftbook',
  'import_skill',

  // Craftbook editing (template authoring + step surgery)
  'craftbook_read',
  'craftbook_write',
  'craftbook_add_step',
  'set_step_deliverable',
  'craftbook_remove_step',
  'craftbook_reorder_steps',
  'craftbook_set_entry',
  'craftbook_update',
  'export_task_craftbook',

  // GitHub (PR + workflow operations)
  'github_pr_list',
  'github_pr_view',
  'github_pr_files',
  'github_pr_file',
  'github_pr_diff',
  'github_pr_comments',
  'github_pr_comment',
  'github_pr_create',
  'github_workflow_runs',
  'github_check_status',
] as const;

/**
 * Tools registered only when their feature or session-context gate is set
 * in the env. Keep contextual/compatibility tools here so inventory users
 * can distinguish them from the ordinary model-facing surface.
 */
export const CONDITIONALLY_REGISTERED_TOOLS = {
  // Compatibility aliases consolidated into smaller primary tools. Hidden
  // from model sessions by default; direct MCP clients can opt in while they
  // migrate by setting GEZEL_MCP_LEGACY_TOOLS=1.
  create_gezel_from_gilde: {
    envVar: 'GEZEL_MCP_LEGACY_TOOLS',
    envValue: '1',
    modelFacing: false,
  },
  start_job: { envVar: 'GEZEL_MCP_LEGACY_TOOLS', envValue: '1', modelFacing: false },
  list_project_local_gezels: {
    envVar: 'GEZEL_MCP_LEGACY_TOOLS',
    envValue: '1',
    modelFacing: false,
  },
  craftbook_create: {
    envVar: 'GEZEL_MCP_LEGACY_TOOLS',
    envValue: '1',
    modelFacing: false,
  },
  craftbook_replace: {
    envVar: 'GEZEL_MCP_LEGACY_TOOLS',
    envValue: '1',
    modelFacing: false,
  },
  // The large surgical-step schema is useful in the explicit craftbook
  // editor, but wasteful on every ordinary coordinator turn. `*` means any
  // non-empty GEZEL_CRAFTBOOK_ID enables it.
  craftbook_update_step: {
    envVar: 'GEZEL_CRAFTBOOK_ID',
    envValue: '*',
    modelFacing: true,
  },
  request_tool_permission: {
    envVar: 'GEZEL_PERMISSION_PROMPT',
    envValue: '1',
    modelFacing: false,
  },
  // Observation-table tools — registered only for projects that actually hold
  // a tabular corpus (the chat manager sets GEZEL_TABLES_ENABLED after a
  // directory probe). The tool listing is injected into every system prompt,
  // so three tools a project can never use are pure prompt cost at depth —
  // and a model that sees a tool tends to reach for it.
  list_tables: { envVar: 'GEZEL_TABLES_ENABLED', envValue: '1', modelFacing: true },
  describe_table: { envVar: 'GEZEL_TABLES_ENABLED', envValue: '1', modelFacing: true },
  query_table: { envVar: 'GEZEL_TABLES_ENABLED', envValue: '1', modelFacing: true },
  // Email write tools — registered only for mail-enabled projects (the chat
  // manager sets GEZEL_MAIL_ENABLED when project.mail is configured).
  draft_email: { envVar: 'GEZEL_MAIL_ENABLED', envValue: '1', modelFacing: true },
  queue_email: { envVar: 'GEZEL_MAIL_ENABLED', envValue: '1', modelFacing: true },
  send_email: { envVar: 'GEZEL_MAIL_ENABLED', envValue: '1', modelFacing: true },
  // Social post write tools — registered only for projects with a social-type
  // connector binding (the chat manager sets GEZEL_SOCIAL_ENABLED).
  draft_post: { envVar: 'GEZEL_SOCIAL_ENABLED', envValue: '1', modelFacing: true },
  queue_post: { envVar: 'GEZEL_SOCIAL_ENABLED', envValue: '1', modelFacing: true },
  publish_post: { envVar: 'GEZEL_SOCIAL_ENABLED', envValue: '1', modelFacing: true },
  // Generic connector writes are draft-only and appear only for projects
  // with at least one connector binding.
  draft_connector_action: {
    envVar: 'GEZEL_CONNECTORS_ENABLED',
    envValue: '1',
    modelFacing: true,
  },
} as const;

export type AlwaysRegisteredToolName = (typeof ALWAYS_REGISTERED_TOOLS)[number];
export type ConditionallyRegisteredToolName = keyof typeof CONDITIONALLY_REGISTERED_TOOLS;

/**
 * Tools an external host harness calls, never the model.
 *
 * Their argument shape is owned by that harness, not by gezel, so it grows
 * whenever the harness ships a new version. Gezel's closed-schema contract
 * (`z.strictObject` in server.ts) is right for the model-facing surface —
 * a hallucinated argument should be rejected loudly — and exactly wrong
 * here: a field the vendor added is not a mistake to reject, it is the new
 * contract. Registration keeps these schemas open so unknown keys are
 * stripped rather than raising `-32602`.
 *
 * The cost of getting this wrong is not local to the callback. Claude
 * Code's `--permission-prompt-tool` points at `request_tool_permission`,
 * and every tool that is NOT on `--allowedTools` routes through it — so a
 * single rejected key takes down every third-party toolset (DocBlocks,
 * Playwright, GitHub, …) for the whole `anthropic-cli` provider while
 * auto-approved gezel-mcp tools keep working, which reads like a
 * per-toolset fault and is not one. That is what `tool_use_id` did.
 */
export const HOST_CALLBACK_TOOLS: ReadonlySet<string> = Object.freeze(
  new Set<string>(['request_tool_permission']),
);

/**
 * Legacy spelling → canonical name for every tool renamed in the
 * snake_case standardization. The old names never appear in `tools/list`
 * (zero prompt cost) but stay callable forever: pinned gilde role
 * templates teach some of them in prose, and lower-capability models
 * guess them from training priors. Dispatch-time resolution lives in
 * server.ts (stdio callers) and mcp-bridge.ts (bridged providers).
 *
 * `GEZEL_MCP_TOOL_NAMING=legacy` flips registration back to these
 * spellings — an A/B lever for the naming experiment, not a supported
 * production mode.
 */
export const RENAMED_TOOLS = {
  readdir: 'list_dir',
  readFile: 'read_file',
  read_multiple_files: 'read_files',
  writeFile: 'write_file',
  appendToFile: 'append_to_file',
  replaceInFile: 'replace_in_file',
  replaceLines: 'replace_lines',
  applyPatch: 'apply_patch',
  insertAtMarker: 'insert_at_marker',
  rm: 'delete_path',
  mkdir: 'make_dir',
  draftEmail: 'draft_email',
  queueEmail: 'queue_email',
  sendEmail: 'send_email',
  // Familiar coding-agent vocabulary improves tool selection for local
  // models. The old semantic name remains a hidden dispatch alias.
  search_files: 'grep_files',
  // Not part of the snake_case sweep — a later, semantic rename. `run_script`
  // read as "run a script", so models that had just written `derive.mjs`
  // called it with a file path and got a "script not found" dead end; the
  // 2026-08-02 core suite caught gemma4-e4b doing this 6 times in one trial
  // and then fabricating the output it could not compute. Measured, not
  // assumed: forcing `prompt.derive-by-execution` (whose text names
  // `derive_file` and `run_nodejs_script` outright) did NOT redirect it —
  // the model still reached for `run_script`. The name is the pull, so the
  // name changes; `run_script` stays callable here forever.
  run_script: 'run_installed_script',
} as const satisfies Record<string, AlwaysRegisteredToolName | ConditionallyRegisteredToolName>;

export type LegacyToolName = keyof typeof RENAMED_TOOLS;

/**
 * Removed, foreign-agent, or UI/client spellings that must never be taught as
 * model-callable MCP tools. Unlike RENAMED_TOOLS these are not dispatch
 * aliases; the registry keeps them only so every model-facing linter shares
 * the same tombstones and replacement guidance.
 */
export const TOOL_NAME_TOMBSTONES = {
  update_task_step: { replacement: undefined, reason: 'no such MCP tool' },
  commitProjectGit: { replacement: undefined, reason: 'UI/client method, not an MCP tool' },
  pushProjectGit: { replacement: undefined, reason: 'UI/client method, not an MCP tool' },
  listAudioVoices: { replacement: undefined, reason: 'UI/client method, not an MCP tool' },
  create_project: { replacement: 'start_project', reason: 'removed project-creation tool' },
  inspect_git_workdir: { replacement: 'run_git', reason: 'foreign coding-agent tool' },
  ensureGezel: { replacement: 'ensure_gezel', reason: 'client method, not an MCP tool' },
  pushProjectGithub: { replacement: undefined, reason: 'client method, not an MCP tool' },
  AskUserQuestion: { replacement: 'ask_user_question', reason: 'foreign coding-agent tool' },
  WebSearch: { replacement: 'web_search', reason: 'foreign coding-agent tool' },
  Grep: { replacement: 'grep_files', reason: 'foreign coding-agent tool' },
  Read: { replacement: 'read_file', reason: 'foreign coding-agent tool' },
  Edit: { replacement: 'replace_in_file', reason: 'foreign coding-agent tool' },
  Agent: { replacement: 'message_gezel', reason: 'foreign coding-agent tool' },
  Bash: { replacement: undefined, reason: 'foreign shell tool; no unrestricted shell is exposed' },
  ExitPlanMode: { replacement: undefined, reason: 'foreign coding-agent control tool' },
} as const satisfies Readonly<
  Record<string, { readonly replacement: CanonicalToolName | undefined; readonly reason: string }>
>;

export type ToolNameTombstone = keyof typeof TOOL_NAME_TOMBSTONES;

export type CanonicalToolName = AlwaysRegisteredToolName | ConditionallyRegisteredToolName;

export interface ToolRegistrationGate {
  readonly envVar: string;
  /** `*` means any non-empty value enables the registration. */
  readonly envValue: string;
}

/**
 * Linter- and registration-friendly metadata for one canonical built-in.
 *
 * `aliases` are hidden callable spellings: they normally do not appear in
 * `tools/list`, though the legacy naming experiment may advertise one in
 * place of the canonical name. `advertisedByDefault` describes the ordinary
 * environment before platform/provider/role filters are applied.
 */
export interface CanonicalToolRegistryEntry {
  readonly canonicalName: CanonicalToolName;
  readonly registration: 'always' | 'conditional';
  readonly gate?: ToolRegistrationGate;
  readonly aliases: readonly LegacyToolName[];
  readonly advertisedByDefault: boolean;
  readonly modelFacing: boolean;
}

/** Canonical built-in names, with conditional names included exactly once. */
export const CANONICAL_TOOL_NAMES = Object.freeze([
  ...ALWAYS_REGISTERED_TOOLS,
  ...(Object.keys(CONDITIONALLY_REGISTERED_TOOLS) as ConditionallyRegisteredToolName[]),
]) as readonly CanonicalToolName[];

/** Hidden callable compatibility spellings, never canonical names. */
export const LEGACY_TOOL_NAMES = Object.freeze(
  Object.keys(RENAMED_TOOLS) as LegacyToolName[],
) as readonly LegacyToolName[];

const aliasesByCanonical = new Map<CanonicalToolName, LegacyToolName[]>();
for (const [alias, canonical] of Object.entries(RENAMED_TOOLS) as Array<
  [LegacyToolName, CanonicalToolName]
>) {
  const aliases = aliasesByCanonical.get(canonical) ?? [];
  aliases.push(alias);
  aliasesByCanonical.set(canonical, aliases);
}

/**
 * Single canonical registry for built-in tool-name consumers such as prompt
 * linters. It unifies ordinary and contextual registrations with every
 * hidden alias, so consumers do not need to recreate joins between the
 * compatibility exports above.
 */
export const TOOL_REGISTRY = Object.freeze(
  Object.fromEntries(
    CANONICAL_TOOL_NAMES.map((canonicalName): [CanonicalToolName, CanonicalToolRegistryEntry] => {
      const conditional = (
        CONDITIONALLY_REGISTERED_TOOLS as Partial<
          Record<CanonicalToolName, ToolRegistrationGate & { readonly modelFacing: boolean }>
        >
      )[canonicalName];
      const aliases = Object.freeze([
        ...(aliasesByCanonical.get(canonicalName) ?? []),
      ]) as readonly LegacyToolName[];
      const entry: CanonicalToolRegistryEntry = conditional
        ? {
            canonicalName,
            registration: 'conditional',
            gate: { envVar: conditional.envVar, envValue: conditional.envValue },
            aliases,
            advertisedByDefault: false,
            modelFacing: conditional.modelFacing,
          }
        : {
            canonicalName,
            registration: 'always',
            aliases,
            advertisedByDefault: true,
            modelFacing: true,
          };
      return [canonicalName, Object.freeze(entry)];
    }),
  ),
) as Readonly<Record<CanonicalToolName, CanonicalToolRegistryEntry>>;

/**
 * Every name reserved by a built-in, including hidden aliases. Dynamic
 * project script tools must not claim any of these spellings because alias
 * dispatch could otherwise route a call to the wrong handler.
 */
export const BUILTIN_TOOL_NAMES = Object.freeze([
  ...CANONICAL_TOOL_NAMES,
  ...LEGACY_TOOL_NAMES,
]) as readonly (CanonicalToolName | LegacyToolName)[];

/**
 * Every spelling a dynamic tool must not claim. Tombstones are not callable,
 * but reserving their namespace prevents a project script from reintroducing
 * a removed/foreign name that model-facing prompts are required to reject.
 */
export const RESERVED_TOOL_NAMES = Object.freeze([
  ...BUILTIN_TOOL_NAMES,
  ...(Object.keys(TOOL_NAME_TOMBSTONES) as ToolNameTombstone[]),
]) as readonly (CanonicalToolName | LegacyToolName | ToolNameTombstone)[];

/** Canonical name → legacy spelling (inverse of {@link RENAMED_TOOLS}). */
export const LEGACY_SPELLING_BY_CANONICAL: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(RENAMED_TOOLS).map(([legacy, canonical]) => [canonical, legacy]),
);

/** Normalized key used by forgiving dispatch and dynamic-name reservation. */
export function normalizeToolNameSpelling(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Resolve any spelling of a built-in tool name to its canonical form.
 * Unknown names (third-party toolset tools, project script tools) pass
 * through unchanged — this maps only the frozen rename table plus
 * case/punctuation variants of it, never fuzzy near-misses.
 */
export function canonicalToolName(name: string): string {
  const direct = (RENAMED_TOOLS as Record<string, string>)[name];
  if (direct) return direct;
  return name;
}

/**
 * Resolve a requested tool name to whatever spelling is live in
 * `knownNames`. Exact hits win; then the frozen rename table in both
 * directions (so `writeFile` resolves when `write_file` is live, and
 * `write_file` resolves in the legacy A/B arm where `writeFile` is
 * live); then a case/punctuation-insensitive match against the live
 * names — `WriteFile`, `write-file`, and `read_dir` all land. Never
 * fuzzy: names that don't resolve return unchanged so "tool not found"
 * errors stay honest. Both the stdio server's dispatch and the
 * service's McpBridge route through this, which is what lets every
 * name-keyed gate downstream assume a single spelling.
 */
export function resolveToolNameSpelling(
  requested: string,
  knownNames: ReadonlySet<string>,
): string {
  if (knownNames.has(requested)) return requested;
  // Explicit tombstones are intentionally not compatibility aliases. Without
  // this guard the generic case/punctuation normalizer would accidentally
  // make foreign names such as AskUserQuestion and WebSearch callable because
  // they normalize to the same spelling as ask_user_question / web_search.
  if (requested in TOOL_NAME_TOMBSTONES) return requested;
  const viaRename = (RENAMED_TOOLS as Record<string, string>)[requested];
  if (viaRename && knownNames.has(viaRename)) return viaRename;
  const viaLegacy = LEGACY_SPELLING_BY_CANONICAL[requested];
  if (viaLegacy && knownNames.has(viaLegacy)) return viaLegacy;
  const wanted = normalizeToolNameSpelling(requested);
  if (!wanted) return requested;
  for (const candidate of knownNames) {
    if (normalizeToolNameSpelling(candidate) === wanted) return candidate;
  }
  for (const [legacy, canonical] of Object.entries(RENAMED_TOOLS)) {
    if (normalizeToolNameSpelling(legacy) === wanted && knownNames.has(canonical)) return canonical;
    if (normalizeToolNameSpelling(canonical) === wanted && knownNames.has(legacy)) return legacy;
  }
  return requested;
}
