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
  'export_project_type',
  'import_project_type',
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
  'start_job',
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

  // Search / files
  'search_files',
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
  create_gezel_from_gilde: { envVar: 'GEZEL_MCP_LEGACY_TOOLS', envValue: '1' },
  list_project_local_gezels: { envVar: 'GEZEL_MCP_LEGACY_TOOLS', envValue: '1' },
  craftbook_create: { envVar: 'GEZEL_MCP_LEGACY_TOOLS', envValue: '1' },
  craftbook_replace: { envVar: 'GEZEL_MCP_LEGACY_TOOLS', envValue: '1' },
  // The large surgical-step schema is useful in the explicit craftbook
  // editor, but wasteful on every ordinary coordinator turn. `*` means any
  // non-empty GEZEL_CRAFTBOOK_ID enables it.
  craftbook_update_step: { envVar: 'GEZEL_CRAFTBOOK_ID', envValue: '*' },
  request_tool_permission: { envVar: 'GEZEL_PERMISSION_PROMPT', envValue: '1' },
  // Email write tools — registered only for mail-enabled projects (the chat
  // manager sets GEZEL_MAIL_ENABLED when project.mail is configured).
  draft_email: { envVar: 'GEZEL_MAIL_ENABLED', envValue: '1' },
  queue_email: { envVar: 'GEZEL_MAIL_ENABLED', envValue: '1' },
  send_email: { envVar: 'GEZEL_MAIL_ENABLED', envValue: '1' },
} as const;

export type AlwaysRegisteredToolName = (typeof ALWAYS_REGISTERED_TOOLS)[number];
export type ConditionallyRegisteredToolName = keyof typeof CONDITIONALLY_REGISTERED_TOOLS;

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

/** Canonical name → legacy spelling (inverse of {@link RENAMED_TOOLS}). */
export const LEGACY_SPELLING_BY_CANONICAL: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(RENAMED_TOOLS).map(([legacy, canonical]) => [canonical, legacy]),
);

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
  const viaRename = (RENAMED_TOOLS as Record<string, string>)[requested];
  if (viaRename && knownNames.has(viaRename)) return viaRename;
  const viaLegacy = LEGACY_SPELLING_BY_CANONICAL[requested];
  if (viaLegacy && knownNames.has(viaLegacy)) return viaLegacy;
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const wanted = normalize(requested);
  if (!wanted) return requested;
  for (const candidate of knownNames) {
    if (normalize(candidate) === wanted) return candidate;
  }
  for (const [legacy, canonical] of Object.entries(RENAMED_TOOLS)) {
    if (normalize(legacy) === wanted && knownNames.has(canonical)) return canonical;
    if (normalize(canonical) === wanted && knownNames.has(legacy)) return legacy;
  }
  return requested;
}
