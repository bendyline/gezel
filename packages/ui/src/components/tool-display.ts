import { stripMcpPrefix } from '@bendyline/gezel';

/**
 * Map each MCP tool's slug to a short, human-friendly display name. Kept
 * in the UI layer (not core) so we can reshape it without touching the
 * wire schema. Entries we don't recognize fall back to the raw name.
 */
const TOOL_DISPLAY_NAMES: Record<string, string> = {
  // Memory
  search_memory: 'Search memory',
  save_memory: 'Save memory',
  list_memories: 'List memories',
  // Workspace files
  list_dir: 'List directory',
  read_file: 'Read file',
  stat: 'Stat path',
  write_file: 'Write file',
  delete_path: 'Delete',
  make_dir: 'Create directory',
  rename: 'Rename',
  // Artifacts
  list_artifacts: 'List artifacts',
  read_artifact: 'Read artifact',
  write_artifact: 'Write artifact',
  // Documents
  list_documents: 'List documents',
  read_document: 'Read document',
  write_document: 'Write document',
  delete_document: 'Delete document',
  // Team management
  list_gezels: 'List gezellen',
  create_gezel: 'Create gezel',
  list_gilde: 'List gezel templates',
  create_gezel_from_gilde: 'Create gezel from template',
  update_gezel: 'Update gezel',
  message_gezel: 'Message gezel',
  // Projects
  list_projects: 'List projects',
  create_project: 'Create project',
  start_project: 'Start project',
  start_job: 'Start job',
  update_project: 'Update project',
  // Tasks
  list_tasks: 'List tasks',
  get_task: 'Get task',
  create_task: 'Create task',
  update_task: 'Update task',
  set_task_status: 'Set task status',
  assign_task: 'Assign task',
  add_task_step: 'Add task step',
  advance_task_step: 'Advance task step',
  read_task_notes: 'Read task notes',
  write_task_note: 'Write task note',
  // Audit / misc
  search_history: 'Search history',
  list_packages: 'List packages',
  // Browser automation
  run_playwright_script: 'Run Playwright script',
};

export function toolDisplayName(name: string): string {
  // Claude CLI references MCP tools as `mcp__<server>__<tool>`. Strip
  // the wire prefix first so the rich-name lookup and the fallback
  // both operate on the bare tool slug ("save_memory" rather than
  // "mcp__gezel__save_memory"). Without this the previous fallback
  // produced UI strings like "mcp gezel save memory".
  let bare = stripMcpPrefix(name);
  // Copilot may surface our MCP tools in its user-visible
  // `gezel-<tool>` wire form. This prefix belongs to the Gezel MCP server;
  // unwrap it before both the rich lookup and unknown-tool fallback.
  if (bare.startsWith('gezel-')) {
    bare = bare.slice('gezel-'.length);
  }
  const displayName = TOOL_DISPLAY_NAMES[bare];
  if (displayName) return displayName;
  // Unknown tools: prefer the `@scope/tool` suffix over the scope itself.
  // `@playwright/mcp`'s tools use `browser_navigate`, `browser_click`, etc.;
  // humanize those inline for a better fallback.
  if (bare.startsWith('browser_')) {
    const rest = bare.slice('browser_'.length).replace(/_/g, ' ');
    return `Browser: ${rest}`;
  }
  return bare.replace(/_/g, ' ');
}

export function formatDurationShort(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}
