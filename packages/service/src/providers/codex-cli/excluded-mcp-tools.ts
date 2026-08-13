/**
 * gezel-mcp tools we hide from the Codex CLI provider so the model doesn't
 * flip-flop between two equivalent mutation surfaces. Codex has first-class
 * built-in shell, file-edit, and web-search tools that overlap with several
 * gezel-mcp execution / write / web tools — registering both sides leaves the
 * model picking arbitrarily turn by turn.
 *
 * Read-only workspace tools are intentionally NOT excluded. Gezel's prompt
 * stack names the scoped MCP contract (`read_file`, `read_files`, `list_dir`,
 * `stat`, `grep_files`, `find_files`, `diff_files`) and role filtering uses
 * that same contract to give reviewers and voormannen inspection without
 * mutation. Hiding those tools while still advertising them made Codex Plan
 * sessions call `read_file` and receive "tool is not available". Keeping the
 * scoped readers is also safer than forcing the model through a general shell:
 * the MCP token and workspace path guards remain authoritative.
 *
 * What stays advertised: the scoped read-only workspace tools plus
 * gezel-unique capabilities Codex has no built-in equivalent for — memories,
 * tasks, team management, projects, documents, history,
 * `ask_user_question`, `render_image`/`generate_image`, and project artifacts.
 *
 * Filtering happens at MCP-registration time via `GEZEL_MCP_EXCLUDE` —
 * the gezel-mcp server's `server.tool` patcher in
 * `packages/mcp/src/server.ts` returns no-op stubs for excluded names so
 * they never appear in the `tools/list` response.
 *
 * This deliberately differs from `CLAUDE_CLI_EXCLUDED_MCP_TOOLS`: Claude's
 * native Read/Grep/Glob surface is named in its prompt contract, whereas the
 * Codex prompt contract and role allowlists name Gezel's scoped MCP readers.
 */
export const CODEX_CLI_EXCLUDED_MCP_TOOLS = [
  // Workspace mutations — Codex has built-in write/edit equivalents.
  'write_file',
  'delete_path',
  'make_dir',
  'rename',
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
