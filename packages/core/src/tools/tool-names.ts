/**
 * Built-in tool spellings shared by every host: the MCP server, the daemon's
 * provider loops, and the portable runtime all resolve a model's tool name the
 * same way. The registry that proves each canonical name exists stays with the
 * MCP server (tool-inventory.ts), which checks this table against it.
 */

/**
 * Legacy spelling → canonical name for every tool renamed in the
 * snake_case standardization. The old names never appear in `tools/list`
 * (zero prompt cost) but stay callable forever: pinned gilde role
 * templates teach some of them in prose, and lower-capability models
 * guess them from training priors. Dispatch-time resolution lives in
 * server.ts (stdio callers), mcp-bridge.ts (bridged providers) and the
 * portable runtime.
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
} as const;

export type LegacyToolName = keyof typeof RENAMED_TOOLS;

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
