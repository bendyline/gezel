import { stripMcpPrefix } from '@bendyline/gezel';

/**
 * Map each tool's wire slug to a short, human-friendly display name.
 *
 * Two rules govern every entry, because these labels are read by people
 * who did not write the tool and never see its schema:
 *
 * 1. **Sentence case**, matching the rest of the app's chrome. The
 *    fallback below capitalizes too, so a tool we've never seen still
 *    lands as "Convert document" rather than a bare slug.
 * 2. **Name the act, not the API.** `grep_files` is an accurate function
 *    name and a poor label — the row says "Search across files" because
 *    that is what the user watched happen. Where the slug already reads
 *    as plain language (`read_file`, `list_tasks`), leave it alone;
 *    inventing prose for a clear name only adds distance.
 *
 * Kept in the UI layer (not core) so we can reshape it without touching
 * the wire schema. The canonical slug list lives in the MCP package's
 * `tool-inventory.ts`; entries we don't recognize fall through to the
 * humanizing fallback rather than erroring, so a new tool is never
 * blocked on updating this file.
 */
export const TOOL_DISPLAY_NAMES: Record<string, string> = {
  // Memory
  search_memory: 'Search memory',
  save_memory: 'Save to memory',
  list_memories: 'List memories',

  // Workspace files
  list_dir: 'List folder contents',
  read_file: 'Read file',
  read_files: 'Read several files',
  stat: 'Check a path exists',
  write_file: 'Write file',
  append_to_file: 'Add to end of file',
  replace_in_file: 'Edit file',
  replace_lines: 'Edit lines in file',
  apply_patch: 'Apply a patch',
  insert_at_marker: 'Insert into file',
  delete_path: 'Delete',
  make_dir: 'Create folder',
  rename: 'Rename',
  copy_artifact_to_workspace: 'Copy into the workspace',
  validate: 'Check the file works',

  // Execution
  npm_install: 'Install packages',
  list_package_scripts: 'List package scripts',
  run_package_script: 'Run package script',
  run_npx: 'Run an npx command',
  run_nodejs_script: 'Run Node.js script',
  derive_file: 'Compute a data file',
  list_packages: 'List packages',
  run_playwright_script: 'Run browser script',

  // Artifacts
  list_artifacts: 'List artifacts',
  read_artifact: 'Read artifact',
  write_artifact: 'Write artifact',
  grep_artifact: 'Search inside an artifact',

  // Documents (shared library)
  list_documents: 'List documents',
  read_document: 'Read document',
  write_document: 'Write document',
  delete_document: 'Delete document',
  search_documents: 'Search the library',

  // Team management
  list_gezels: 'List gezellen',
  create_gezel: 'Create gezel',
  create_gezel_from_gilde: 'Create gezel from template',
  ensure_gezel: 'Find or create a gezel',
  update_gezel: 'Update gezel',
  list_gilde: 'Browse gezel templates',
  message_gezel: 'Message a gezel',
  ask_gezel: 'Ask a gezel',
  ask_specialist: 'Ask a specialist',

  // Projects
  list_projects: 'List projects',
  start_project: 'Start a project',
  start_job: 'Start job',
  update_project: 'Update project',
  fetch_repo: 'Fetch a repository',
  fetch_diff: 'Fetch code changes to review',
  list_project_gezels: 'List the project crew',
  list_project_local_gezels: 'List the project crew',
  add_gezel_to_project: 'Add gezel to project',
  remove_gezel_from_project: 'Remove gezel from project',
  list_project_types: 'List project types',
  apply_project_type: 'Apply project type',
  start_project_from_type: 'Start project from a type',
  export_ai_app: 'Export AI App',
  import_ai_app: 'Import AI App',
  list_suggested_work: 'List suggested work',
  enable_suggested_work: 'Turn on suggested work',
  disable_suggested_work: 'Turn off suggested work',

  // Tasks
  list_tasks: 'List tasks',
  get_task: 'Open task',
  create_task: 'Create task',
  start_plan: 'Start a plan',
  update_task: 'Update task',
  set_outcomes: 'Set what success looks like',
  verify_outcome: 'Verify an outcome',
  add_verification_step: 'Add a verification step',
  spawn_task_instances: 'Split into subtasks',
  list_task_children: 'List subtasks',
  set_task_status: 'Set task status',
  activate_task: 'Activate task',
  assign_task: 'Assign task',
  add_task_step: 'Add task step',
  advance_task_step: 'Advance task step',
  read_task_notes: 'Read task notes',
  write_task_note: 'Write task note',

  // Asking the user
  ask_user_question: 'Ask you a question',
  request_tool_permission: 'Ask your permission',

  // Audit / history
  search_history: 'Search history',
  search_sessions: 'Search past chats',

  // Handboek (built-in documentation)
  how_do_i: 'Look it up in the Handboek',

  // Search across the workspace
  grep_files: 'Search across files',
  find_files: 'Find files by name',
  diff_files: 'Compare two files',

  // Code intelligence
  outline_file: 'Outline a file',
  find_symbol: 'Find a symbol',
  read_symbol: 'Read a symbol',
  find_references: 'Find references',
  map_repo: 'Map the codebase',
  search_code: 'Search the code',
  file_review: 'Review a file',
  list_file_issues: 'List file issues',
  get_file_issue: 'Open a file issue',
  set_file_issue_status: 'Update a file issue',

  // Security intelligence
  security_scan: 'Run a security scan',
  security_overview: 'Review the security picture',
  scan_findings: 'List security findings',
  map_attack_surface: 'Map the attack surface',
  list_dependencies: 'List dependencies',
  trace_taint: 'Trace untrusted input',

  // Document intelligence
  search_docs: 'Search documents',
  read_doc_as_markdown: 'Read a document as text',

  // Images
  render_image: 'Render image',
  generate_image: 'Generate image',
  describe_image: 'Describe an image',
  read_image_metadata: 'Read image details',
  read_image_as_base64: 'Load an image',
  search_images: 'Search images',
  find_similar_images: 'Find similar images',
  describe_folder: 'Summarize a folder of images',

  // Video / audio
  generate_video: 'Generate video',
  transcribe_audio: 'Transcribe audio',
  synthesize_speech: 'Read text aloud',

  // Entity intelligence
  find_entity: 'Find a person or party',
  list_entity_mentions: 'List where they appear',

  // Web
  fetch_url: 'Open a web page',
  web_search: 'Search the web',
  wikipedia_search: 'Search Wikipedia',
  wikipedia_read: 'Read a Wikipedia article',

  // Archives
  list_archive: 'List archive contents',
  extract_archive: 'Extract an archive',

  // Git
  run_git: 'Run a git command',

  // Scripts
  list_scripts: 'List scripts',
  run_installed_script: 'Run a script',
  get_script_run: 'Check a script run',

  // Craftbooks
  list_craftbooks: 'List craftbooks',
  suggest_craftbook: 'Suggest a craftbook',
  invoke_craftbook: 'Start a craftbook',
  import_skill: 'Import a skill',
  craftbook_read: 'Read craftbook',
  craftbook_write: 'Write craftbook',
  craftbook_create: 'Create craftbook',
  craftbook_replace: 'Replace craftbook',
  craftbook_update: 'Update craftbook',
  craftbook_add_step: 'Add craftbook step',
  craftbook_remove_step: 'Remove craftbook step',
  craftbook_reorder_steps: 'Reorder craftbook steps',
  craftbook_update_step: 'Update craftbook step',
  craftbook_set_entry: 'Set craftbook entry point',
  set_step_deliverable: 'Set what the step delivers',
  export_task_craftbook: 'Save this task as a craftbook',

  // Mail / social / connectors
  draft_email: 'Draft an email',
  queue_email: 'Queue an email',
  send_email: 'Send an email',
  draft_post: 'Draft a post',
  queue_post: 'Queue a post',
  publish_post: 'Publish a post',
  draft_connector_action: 'Draft an action',

  // GitHub
  github_pr_list: 'List pull requests',
  github_pr_view: 'View a pull request',
  github_pr_files: 'List the changed files',
  github_pr_file: 'Read a changed file',
  github_pr_diff: 'Read the changes',
  github_pr_comments: 'Read review comments',
  github_pr_comment: 'Comment on the pull request',
  github_pr_create: 'Open a pull request',
  github_workflow_runs: 'List workflow runs',
  github_check_status: 'Check CI status',

  // Browser automation (@playwright/mcp)
  browser_navigate: 'Open a web page',
  browser_navigate_back: 'Go back a page',
  browser_click: 'Click on the page',
  browser_type: 'Type on the page',
  browser_fill_form: 'Fill in a form',
  browser_select_option: 'Choose an option',
  browser_hover: 'Hover on the page',
  browser_press_key: 'Press a key',
  browser_snapshot: 'Read the page',
  browser_take_screenshot: 'Take a screenshot',
  browser_evaluate: 'Run script on the page',
  browser_wait_for: 'Wait for the page',
  browser_console_messages: 'Read the browser console',
  browser_network_requests: 'Read network requests',
  browser_file_upload: 'Upload a file',
  browser_handle_dialog: 'Answer a browser dialog',
  browser_resize: 'Resize the browser',
  browser_tabs: 'Switch browser tabs',
  browser_close: 'Close the browser',
  browser_find_page_element: 'Find something on the page',

  // Coding-agent built-ins. These reach the tool rows when a CLI provider
  // (Claude Code, Codex) runs its own file/shell tools instead of ours, so
  // a session shouldn't look like two different products depending on which
  // provider answered.
  Read: 'Read file',
  Write: 'Write file',
  Edit: 'Edit file',
  Grep: 'Search across files',
  Glob: 'Find files by name',
  Bash: 'Run a command',
  shell: 'Run a command',
  local_shell: 'Run a command',
  WebFetch: 'Open a web page',
  WebSearch: 'Search the web',
  TodoWrite: 'Update the plan',
  update_plan: 'Update the plan',
  NotebookEdit: 'Edit a notebook',
  view_image: 'Look at an image',
  file_change: 'Update files',
  mcp_tool_call: 'Use a tool',
};

/**
 * Role-typed delegation tools (`delegate_developer`, `consult_designer`, …)
 * are twenty near-identical entries; generating them keeps the pairs from
 * drifting apart when a new role is added. The article is baked into the
 * label ("the developer") because these address a specific crew member,
 * not a category.
 */
const DELEGATION_ROLE_LABELS: Record<string, string> = {
  developer: 'developer',
  designer: 'designer',
  reviewer: 'reviewer',
  planner: 'planner',
  researcher: 'researcher',
  builder: 'builder',
  writer: 'writer',
  image_generator: 'image maker',
  voorman: 'voorman',
  meester: 'Meester',
};

for (const [role, label] of Object.entries(DELEGATION_ROLE_LABELS)) {
  TOOL_DISPLAY_NAMES[`delegate_${role}`] = `Hand work to the ${label}`;
  TOOL_DISPLAY_NAMES[`consult_${role}`] = `Ask the ${label}`;
}

/**
 * Capitalize the first character and leave the rest alone. Deliberately not
 * `text-transform: capitalize` or a word-by-word upper: proper nouns
 * ("Node.js", "npx", "GitHub") appear mid-label and must survive.
 */
function capitalizeFirst(text: string): string {
  if (!text) return text;
  return text[0]!.toUpperCase() + text.slice(1);
}

/**
 * Reduce a wire tool name to the bare slug the label map is keyed on.
 *
 * Claude CLI references MCP tools as `mcp__<server>__<tool>`, and Copilot
 * surfaces ours in its user-visible `gezel-<tool>` form. Both prefixes
 * belong to the transport rather than the tool, and leaving them on misses
 * the lookup — which is how the fallback once produced UI strings like
 * "mcp gezel save memory".
 */
function bareToolSlug(name: string): string {
  const bare = stripMcpPrefix(name);
  return bare.startsWith('gezel-') ? bare.slice('gezel-'.length) : bare;
}

export function toolDisplayName(name: string): string {
  const bare = bareToolSlug(name);
  const displayName = TOOL_DISPLAY_NAMES[bare];
  if (displayName) return displayName;
  // Unknown tools: prefer the `@scope/tool` suffix over the scope itself.
  // `@playwright/mcp`'s tools use `browser_navigate`, `browser_click`, etc.;
  // humanize those inline for a better fallback.
  if (bare.startsWith('browser_')) {
    const rest = bare.slice('browser_'.length).replace(/_/g, ' ');
    return `Browser: ${rest}`;
  }
  return capitalizeFirst(bare.replace(/_/g, ' '));
}

/**
 * True when the slug has a curated label — that is, when we know what the
 * tool does rather than merely how to spell it. Callers use this to decide
 * whether a name is worth phrasing in prose.
 */
export function isKnownTool(name: string): boolean {
  return TOOL_DISPLAY_NAMES[bareToolSlug(name)] !== undefined;
}

/**
 * English `-ing` spelling, as four rules applied in order.
 *
 * Safe to do by rule rather than by table because every label in
 * {@link TOOL_DISPLAY_NAMES} opens with a bare-infinitive verb, and the
 * present participle is the one English inflection with no irregular
 * forms — only irregular spellings, all four of which are below. (Past
 * tense would need a table: write/wrote, find/found, read/read.)
 */
function gerund(verb: string): string {
  const lower = verb.toLowerCase();
  // A final -e that carries its own vowel sound stays: "see" → "seeing",
  // and dropping it from "dye" would collide with a different word.
  if (/(?:ee|oe|ye)$/.test(lower)) return `${lower}ing`;
  // Silent final -e goes: "create" → "creating", "queue" → "queuing".
  if (/e$/.test(lower)) return `${lower.slice(0, -1)}ing`;
  // Single-syllable consonant-vowel-consonant doubles its last letter:
  // "run" → "running", "split" → "splitting". Matching on *exactly one
  // vowel in the whole word* is what keeps multi-syllable look-alikes out
  // — "edit" ends in a CVC run but holds two vowels, and "editting" is not
  // a word. `w`, `x`, and `y` never double.
  if (/^[^aeiou]*[aeiou][^aeiouwxy]$/.test(lower)) return `${lower + lower.slice(-1)}ing`;
  return `${lower}ing`;
}

/**
 * The same act as {@link toolDisplayName}, phrased as something someone is
 * doing right now: `grep_files` → "Searching across files".
 *
 * A chat row can label a tool, because the row sits under a timestamp and
 * an avatar that already say who did it and when. A one-line summary — a
 * thread pill, a task card — has no such frame, and a bare "Search across
 * files" there reads as an instruction to the person, not a report about
 * the gezel. This is the form to use whenever a tool call has to stand in
 * for a message.
 *
 * Only mapped labels are conjugated. The unknown-tool fallback builds its
 * label from the slug, whose first token is not reliably a verb, and a
 * guessed gerund ("Someing new tool") is worse than the plain label.
 */
export function toolActivityPhrase(name: string): string {
  const label = toolDisplayName(name);
  if (!isKnownTool(name)) return label;
  const space = label.indexOf(' ');
  if (space === -1) return capitalizeFirst(gerund(label));
  return capitalizeFirst(gerund(label.slice(0, space))) + label.slice(space);
}

/**
 * Turn JSON-string fragments in a persisted argument summary back into
 * ordinary display text. The summary builder quotes string values with
 * `JSON.stringify`, which is correct for storage but otherwise exposes
 * escapes such as `\"dsaav\"` in chat. Parse only complete quoted tokens;
 * malformed or truncated fragments stay untouched rather than guessing.
 */
export function toolArgsDisplaySummary(summary: string): string {
  return summary.replace(/"(?:\\.|[^"\\])*"/g, (token) => {
    try {
      const parsed: unknown = JSON.parse(token);
      return typeof parsed === 'string' ? parsed : token;
    } catch {
      return token;
    }
  });
}

/** Cap for {@link toolErrorSummary} — long enough for a gate's first
 *  rejected criterion, short enough that a failed row stays one glance. */
export const TOOL_ERROR_SUMMARY_MAX = 250;

/** `[gate_rejected] `, `[not_found] ` — the machine code every MCP error
 *  result carries. Useful to the model, noise in a transcript. */
const MACHINE_CODE_PREFIX = /^\[[a-z0-9_]+\]\s*/i;

/** `Retryable: true` is a control flag for the caller, not a reason. */
const RETRYABLE_FLAG = /^retryable:\s*(?:true|false)$/i;

/**
 * Condense a failed tool call's error into a bounded, readable reason for
 * the chat thread.
 *
 * The raw text is written for the model — a machine code prefix, the
 * rejection itself, then a `Retryable:` flag. The person reading the
 * transcript needs the middle part, and needs it without opening the
 * details drawer: a red ✗ next to "Advance task step" tells them a gate
 * fired but not what it wanted. Line breaks survive (a gate lists its
 * unmet criteria as bullets, and running those together is unreadable);
 * the full untruncated text stays in the details drawer and the row's
 * native tooltip.
 */
export function toolErrorSummary(message: string, maxChars = TOOL_ERROR_SUMMARY_MAX): string {
  const text = message
    .replace(MACHINE_CODE_PREFIX, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => !RETRYABLE_FLAG.test(line.trim()))
    .join('\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  // Break on the last whitespace so the cut lands between words — unless
  // that would throw away most of the budget (one long unbroken token),
  // in which case a mid-word cut is the honest option.
  const lastSpace = cut.search(/\s\S*$/);
  const body = lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${body.replace(/[\s.,;:-]+$/, '')}…`;
}

export function formatDurationShort(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}
