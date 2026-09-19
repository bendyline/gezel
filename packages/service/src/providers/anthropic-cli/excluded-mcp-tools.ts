/**
 * gezel-mcp tools we hide from the Claude CLI provider so the model doesn't
 * flip-flop between two equivalent surfaces. Claude has first-class built-in
 * tools (`Read`, `Write`, `Edit`, `Grep`, `Glob`, `Bash`, `WebFetch`,
 * `WebSearch`, `NotebookEdit`, `TodoWrite`) that overlap with several
 * gezel-mcp filesystem / execution / web tools — registering both sides
 * leaves the model picking arbitrarily turn by turn.
 *
 * What stays advertised: gezel-unique capabilities Claude has no built-in
 * equivalent for — memories, tasks, team management, projects, documents,
 * history, `ask_user_question`, `render_image`/`generate_image`, project
 * artifacts, and `run_git` (Claude has Bash but no read-only git wrapper).
 *
 * `run_package_script`, `run_npx` and `list_package_scripts` also stay, even
 * though Bash can run the same commands: they are the only runners that write
 * the `workspace.script.run` / `workspace.npx.run` receipts a craftbook's
 * `commandEvidence` gate accepts. Hidden, every book that proves its work by
 * running the suite was unpassable on this provider — the verify step of
 * codemod-sweep rejected four times with "no `npm run test` run was observed"
 * while the model had already run the suite through Bash, and its ToolSearch
 * for the runner the gate named found nothing (Opus, 2026-09-19, both
 * execution modes). A receipt-bearing tool is not a duplicate of a shell.
 *
 * Filtering happens at MCP-registration time via `GEZEL_MCP_EXCLUDE` —
 * the gezel-mcp server's `server.tool` patcher in
 * `packages/mcp/src/server.ts` returns no-op stubs for excluded names so
 * they never appear in the `tools/list` response.
 */
export const CLAUDE_CLI_EXCLUDED_MCP_TOOLS = [
  // Filesystem ops — Claude has Read/Write/Edit.
  'list_dir',
  'read_file',
  'read_files',
  'stat',
  'write_file',
  'delete_path',
  'make_dir',
  'rename',
  // Search ops — Claude has Grep/Glob.
  'grep_files',
  'find_files',
  'diff_files',
  // Web ops — Claude has WebFetch/WebSearch.
  'fetch_url',
  'web_search',
  // Execution ops — Claude has Bash. The package-script runners are NOT
  // here: see the receipt note in the header.
  'npm_install',
  'run_nodejs_script',
  'run_playwright_script',
  'list_packages',
  // Image / archive helpers also covered by Read + Bash.
  'read_image_as_base64',
  'list_archive',
  'extract_archive',
];
