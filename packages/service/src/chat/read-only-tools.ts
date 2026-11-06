/**
 * MCP tools that only read state. A voorman turn that fires only these
 * (or no tools at all) counts as "did nothing proactive" for the
 * voorman-idle stall check. Any tool not in this set is treated as
 * mutating — safer to assume a novel tool did something than to miss a
 * real handoff. Naming also follows a convention (list_*, read_*, get_*,
 * search_*) that `isReadOnlyToolName` falls back on for forward compat.
 */
const READ_ONLY_MCP_TOOLS: ReadonlySet<string> = new Set([
  'search',
  'search_memory',
  'list_memories',
  'list_dir',
  'read_file',
  'stat',
  'list_artifacts',
  'read_artifact',
  'read_artifacts',
  'list_packages',
  'list_documents',
  'read_document',
  'list_gezels',
  'list_gilde',
  'list_projects',
  'list_tasks',
  'get_task',
  'read_task_notes',
  'search_history',
  // Procedure discovery/inspection is not execution. A successful
  // suggestion must still be followed by invoke_craftbook (or start_work).
  'suggest_craftbook',
  'suggest_work',
  'craftbook_read',
]);

export function isReadOnlyToolName(name: string): boolean {
  if (READ_ONLY_MCP_TOOLS.has(name)) return true;
  // Forward-compat: new tools that follow the read-only naming convention
  // count as read-only so a future `list_channels` doesn't get flagged
  // as a mutation. Conservative — a mutating tool named `get_quote` would
  // be a false positive, but the project's naming discipline makes that
  // unlikely enough that the simpler rule wins.
  return /^(?:list|read|get|search|has|suggest)_/.test(name);
}
