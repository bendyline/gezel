/**
 * gezel-mcp tools we hide from the Codex CLI provider so the model doesn't
 * flip-flop between two equivalent surfaces. Codex has first-class built-in
 * shell, file-edit, and web-search tools that overlap with several gezel-mcp
 * filesystem / execution / web tools — registering both sides leaves the
 * model picking arbitrarily turn by turn.
 *
 * What stays advertised: gezel-unique capabilities Codex has no built-in
 * equivalent for — memories, tasks, team management, projects, documents,
 * history, `ask_user_question`, `render_image`/`generate_image`, and
 * project artifacts.
 *
 * Filtering happens at MCP-registration time via `GEZEL_MCP_EXCLUDE` —
 * the gezel-mcp server's `server.tool` patcher in
 * `packages/mcp/src/server.ts` returns no-op stubs for excluded names so
 * they never appear in the `tools/list` response.
 *
 * Mirrors `CLAUDE_CLI_EXCLUDED_MCP_TOOLS` — Codex's overlap surface is
 * effectively the same as Claude Code's.
 */
export const CODEX_CLI_EXCLUDED_MCP_TOOLS = [
  // Filesystem ops — Codex has built-in read/write/edit equivalents.
  'list_dir',
  'read_file',
  'stat',
  'write_file',
  'delete_path',
  'make_dir',
  'rename',
  // Search ops — Codex shell can grep/glob.
  'search_files',
  'find_files',
  'diff_files',
  // Web ops — Codex has built-in web_search.
  'fetch_url',
  'web_search',
  // Execution ops — Codex shell handles these.
  'npm_install',
  'list_package_scripts',
  'run_package_script',
  'run_npx',
  'run_nodejs_script',
  'run_playwright_script',
  'list_packages',
  // Image / archive helpers also covered by built-ins.
  'read_image_as_base64',
  'list_archive',
  'extract_archive',
];
