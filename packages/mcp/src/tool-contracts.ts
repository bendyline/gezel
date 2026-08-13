import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { type CanonicalToolName, TOOL_REGISTRY, canonicalToolName } from './tool-inventory.js';

/**
 * Common result fields shared by Gezel tools that advertise an output schema.
 * The summary is deliberately first: clients that render structured content can
 * show it without having to understand the tool-specific payload.
 */
export const ToolResultSummarySchema = z.object({
  summary: z.string().min(1),
});

const SearchMatchSchema = z
  .object({
    path: z.string().optional(),
    line: z.number().int().positive().optional(),
    lineStart: z.number().int().positive().optional(),
    lineEnd: z.number().int().positive().optional(),
    text: z.string().optional(),
    snippet: z.string().optional(),
    name: z.string().optional(),
    source: z.string().optional(),
    score: z.number().optional(),
    day: z.string().optional(),
    scope: z.string().optional(),
    before: z.array(z.object({ line: z.number().int().positive(), text: z.string() })).optional(),
    after: z.array(z.object({ line: z.number().int().positive(), text: z.string() })).optional(),
  })
  .catchall(z.unknown());

const ListItemSchema = z
  .object({
    id: z.string().optional(),
    ref: z.string().optional(),
    path: z.string().optional(),
    name: z.string().optional(),
    title: z.string().optional(),
    role: z.string().optional(),
    version: z.string().optional(),
    command: z.string().optional(),
    status: z.string().optional(),
    isDirectory: z.boolean().optional(),
  })
  .catchall(z.unknown());

export const SearchToolOutputSchema = ToolResultSummarySchema.extend({
  query: z.string().optional(),
  matches: z.array(SearchMatchSchema),
  count: z.number().int().nonnegative(),
  truncated: z.boolean().optional(),
  engine: z.string().optional(),
  mode: z.string().optional(),
  nextCursor: z.number().int().nonnegative().optional(),
  truncationReason: z.string().optional(),
});

export const ListToolOutputSchema = ToolResultSummarySchema.extend({
  items: z.array(ListItemSchema),
  count: z.number().int().nonnegative(),
  truncated: z.boolean().optional(),
  packageManager: z.string().optional(),
});

export const StatToolOutputSchema = ToolResultSummarySchema.extend({
  path: z.string(),
  kind: z.enum(['file', 'dir', 'missing']),
  size: z.number().int().nonnegative().optional(),
  mtime: z.string().optional(),
});

const TaskRecordSchema = z
  .object({
    ref: z.string().optional(),
    title: z.string().optional(),
    status: z.string().optional(),
    activeStepId: z.string().nullable().optional(),
    assignee: z.record(z.string(), z.unknown()).optional(),
    craftbook: z.record(z.string(), z.unknown()).optional(),
  })
  .catchall(z.unknown());

export const TaskToolOutputSchema = ToolResultSummarySchema.extend({
  operation: z.string(),
  ref: z.string().optional(),
  status: z.string().optional(),
  stepId: z.string().optional(),
  task: TaskRecordSchema.nullable().optional(),
  tasks: z.array(TaskRecordSchema).optional(),
  count: z.number().int().nonnegative().optional(),
  note: TaskRecordSchema.optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export const ExecutionToolOutputSchema = ToolResultSummarySchema.extend({
  state: z.enum(['completed', 'approval_pending', 'running', 'failed']),
  ok: z.boolean(),
  code: z.number().int().optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  stdoutTruncated: z.boolean().optional(),
  stderrTruncated: z.boolean().optional(),
  timedOut: z.boolean().optional(),
  error: z.string().optional(),
  approvalPending: z.boolean().optional(),
  questionId: z.string().optional(),
  declined: z.string().optional(),
  resolvedBinPath: z.string().optional(),
  runId: z.string().optional(),
  calls: z.array(z.record(z.string(), z.unknown())).optional(),
  logs: z.string().optional(),
  output: z.unknown().optional(),
});

export const GitToolOutputSchema = ExecutionToolOutputSchema.extend({
  command: z.literal('git'),
  args: z.array(z.string()),
});

export const MemorySaveToolOutputSchema = ToolResultSummarySchema.extend({
  status: z.enum(['saved', 'duplicate']),
  scope: z.enum(['gezel', 'project']),
});

export const MemoryListToolOutputSchema = ToolResultSummarySchema.extend({
  scope: z.enum(['gezel', 'project']),
  days: z.number().int().positive(),
  content: z.string(),
});

export const ActionToolOutputSchema = ToolResultSummarySchema.extend({
  status: z.string(),
  draftId: z.string().optional(),
  relPath: z.string().optional(),
  messageId: z.string().optional(),
});

export const BatchReadToolOutputSchema = z.object({
  results: z.array(
    z.object({
      path: z.string(),
      status: z.enum(['ok', 'error']),
      startLine: z.number().int().positive().optional(),
      endLine: z.number().int().nonnegative().optional(),
      completeFile: z.boolean().optional(),
      code: z.string().optional(),
    }),
  ),
});

export const EditToolOutputSchema = z.object({
  diff: z.string(),
  addedLines: z.number().int().nonnegative(),
  removedLines: z.number().int().nonnegative(),
  diffTruncated: z.boolean().optional(),
});

export const VideoToolOutputSchema = z.object({
  gezelVideo: z.object({
    artifactPath: z.string(),
    mimeType: z.string(),
  }),
});

export type ToolOutputSchema = z.ZodType;

const TOOL_OUTPUT_SCHEMAS = {
  search_memory: SearchToolOutputSchema,
  save_memory: MemorySaveToolOutputSchema,
  list_memories: MemoryListToolOutputSchema,
  search_documents: SearchToolOutputSchema,
  grep_files: SearchToolOutputSchema,
  find_files: SearchToolOutputSchema,
  search_code: SearchToolOutputSchema,
  list_dir: ListToolOutputSchema,
  read_files: BatchReadToolOutputSchema,
  list_artifacts: ListToolOutputSchema,
  list_documents: ListToolOutputSchema,
  list_gezels: ListToolOutputSchema,
  list_projects: ListToolOutputSchema,
  list_tasks: TaskToolOutputSchema,
  list_task_children: TaskToolOutputSchema,
  list_package_scripts: ListToolOutputSchema,
  list_packages: ListToolOutputSchema,
  list_scripts: ListToolOutputSchema,
  stat: StatToolOutputSchema,
  replace_in_file: EditToolOutputSchema,
  replace_lines: EditToolOutputSchema,
  apply_patch: EditToolOutputSchema,
  insert_at_marker: EditToolOutputSchema,
  get_task: TaskToolOutputSchema,
  create_task: TaskToolOutputSchema,
  start_plan: TaskToolOutputSchema,
  update_task: TaskToolOutputSchema,
  set_outcomes: TaskToolOutputSchema,
  verify_outcome: TaskToolOutputSchema,
  add_verification_step: TaskToolOutputSchema,
  spawn_task_instances: TaskToolOutputSchema,
  set_task_status: TaskToolOutputSchema,
  activate_task: TaskToolOutputSchema,
  assign_task: TaskToolOutputSchema,
  add_task_step: TaskToolOutputSchema,
  advance_task_step: TaskToolOutputSchema,
  read_task_notes: TaskToolOutputSchema,
  write_task_note: TaskToolOutputSchema,
  npm_install: ListToolOutputSchema,
  run_package_script: ExecutionToolOutputSchema,
  run_npx: ExecutionToolOutputSchema,
  run_nodejs_script: ExecutionToolOutputSchema,
  derive_file: ExecutionToolOutputSchema,
  run_playwright_script: ExecutionToolOutputSchema,
  run_installed_script: ExecutionToolOutputSchema,
  get_script_run: ExecutionToolOutputSchema,
  run_git: GitToolOutputSchema,
  generate_video: VideoToolOutputSchema,
  draft_email: ActionToolOutputSchema,
  queue_email: ActionToolOutputSchema,
  send_email: ActionToolOutputSchema,
  draft_post: ActionToolOutputSchema,
  queue_post: ActionToolOutputSchema,
  publish_post: ActionToolOutputSchema,
  draft_connector_action: ActionToolOutputSchema,
} as const satisfies Partial<Record<CanonicalToolName, ToolOutputSchema>>;

/** Output schema advertised for tools migrated to the structured contract. */
export function outputSchemaForTool(name: string): ToolOutputSchema | undefined {
  const canonical = canonicalToolName(name) as keyof typeof TOOL_OUTPUT_SCHEMAS;
  return Object.prototype.hasOwnProperty.call(TOOL_OUTPUT_SCHEMAS, canonical)
    ? TOOL_OUTPUT_SCHEMAS[canonical]
    : undefined;
}

interface OkResultOptions {
  /**
   * Optional richer text for clients that do not consume structuredContent.
   * When omitted, the validated object is serialized after the summary, as
   * recommended by MCP for backwards compatibility.
   */
  text?: string;
}

/**
 * Build a successful MCP result and validate it before it leaves the handler.
 * The SDK validates it again against the advertised outputSchema at dispatch;
 * validating here keeps direct unit tests and helper callers honest too.
 */
export function okResult<T extends Record<string, unknown>>(
  schema: z.ZodType<T>,
  value: T,
  options: OkResultOptions = {},
): CallToolResult {
  const structuredContent = schema.parse(value);
  const serialized = JSON.stringify(structuredContent);
  const text = options.text ?? `${structuredContent.summary}\n${serialized}`;
  return {
    content: [{ type: 'text', text }],
    structuredContent,
  };
}

export interface ToolErrorOptions {
  code?: string;
  retryable?: boolean;
  hint?: string;
}

/**
 * Build an MCP tool-execution failure. These are results, rather than JSON-RPC
 * protocol errors, so the model receives actionable feedback and can repair
 * the call. Keeping this helper tiny makes the correct `isError` bit hard to
 * forget in catch and business-rule branches.
 */
export function errorResult(message: string, options: ToolErrorOptions = {}): CallToolResult {
  const prefix = options.code ? `[${options.code}] ` : '';
  const retry = options.retryable === undefined ? '' : `\nRetryable: ${options.retryable}`;
  const hint = options.hint ? `\nNext: ${options.hint}` : '';
  return {
    content: [{ type: 'text', text: `${prefix}${message}${retry}${hint}` }],
    isError: true,
  };
}

/**
 * Operations whose advertised purpose is observation. Everything not listed
 * here is conservatively described as mutating; annotations are routing and UX
 * hints, never an authorization boundary.
 */
const READ_ONLY_TOOLS = new Set<CanonicalToolName>([
  'search_memory',
  'list_memories',
  'list_dir',
  'read_file',
  'read_files',
  'stat',
  'validate',
  'list_package_scripts',
  'list_packages',
  'list_artifacts',
  'read_artifact',
  'grep_artifact',
  'browser_find_page_element',
  'list_documents',
  'read_document',
  'search_documents',
  'list_gezels',
  'list_gilde',
  'list_project_types',
  'list_projects',
  'list_project_gezels',
  'list_suggested_work',
  'list_tasks',
  'get_task',
  'list_task_children',
  'read_task_notes',
  'search_history',
  'search_sessions',
  'how_do_i',
  'describe_image',
  'read_image_metadata',
  'fetch_url',
  'web_search',
  'wikipedia_search',
  'grep_files',
  'find_files',
  'diff_files',
  'read_image_as_base64',
  'outline_file',
  'find_symbol',
  'read_symbol',
  'find_references',
  'map_repo',
  'search_code',
  'file_review',
  'list_file_issues',
  'get_file_issue',
  'security_overview',
  'scan_findings',
  'map_attack_surface',
  'list_dependencies',
  'trace_taint',
  'search_docs',
  'read_doc_as_markdown',
  'search_images',
  'find_similar_images',
  'describe_folder',
  'find_entity',
  'list_entity_mentions',
  'list_archive',
  'list_scripts',
  'get_script_run',
  'list_craftbooks',
  'suggest_craftbook',
  'craftbook_read',
  'github_pr_list',
  'github_pr_view',
  'github_pr_files',
  'github_pr_diff',
  'github_pr_comments',
  'github_workflow_runs',
  'github_check_status',
]);

/** Additive writes which do not replace or delete existing state by design. */
const NON_DESTRUCTIVE_MUTATIONS = new Set<CanonicalToolName>([
  'save_memory',
  'append_to_file',
  'make_dir',
  'fetch_repo',
  'fetch_diff',
  'create_gezel',
  'start_project',
  'ensure_gezel',
  'message_gezel',
  'ask_gezel',
  'ask_specialist',
  'delegate_developer',
  'delegate_designer',
  'delegate_reviewer',
  'delegate_planner',
  'delegate_researcher',
  'delegate_builder',
  'delegate_writer',
  'delegate_image_generator',
  'delegate_voorman',
  'delegate_meester',
  'consult_developer',
  'consult_designer',
  'consult_reviewer',
  'consult_planner',
  'consult_researcher',
  'consult_builder',
  'consult_writer',
  'consult_image_generator',
  'consult_voorman',
  'consult_meester',
  'ask_user_question',
  'add_gezel_to_project',
  'enable_suggested_work',
  'create_task',
  'start_plan',
  'add_verification_step',
  'spawn_task_instances',
  'add_task_step',
  'write_task_note',
  'transcribe_audio',
  'synthesize_speech',
  'import_skill',
  'invoke_craftbook',
  'craftbook_add_step',
  'export_task_craftbook',
  'github_pr_comment',
  'github_pr_create',
  'draft_email',
  'queue_email',
  'draft_post',
  'queue_post',
  'draft_connector_action',
  'request_tool_permission',
]);

/** Mutations that converge when called repeatedly with identical arguments. */
const IDEMPOTENT_MUTATIONS = new Set<CanonicalToolName>([
  'save_memory',
  'write_file',
  'make_dir',
  'delete_path',
  'copy_artifact_to_workspace',
  'write_artifact',
  'write_document',
  'delete_document',
  'update_gezel',
  'update_project',
  'add_gezel_to_project',
  'remove_gezel_from_project',
  'enable_suggested_work',
  'disable_suggested_work',
  'update_task',
  'set_outcomes',
  'activate_task',
  'assign_task',
  'craftbook_write',
  'craftbook_set_entry',
  'craftbook_update',
  'craftbook_update_step',
]);

/** Tools that may communicate with entities or services outside Gezel. */
const OPEN_WORLD_TOOLS = new Set<CanonicalToolName>([
  'npm_install',
  'run_package_script',
  'run_npx',
  'run_playwright_script',
  'run_installed_script',
  'generate_image',
  'ask_user_question',
  'fetch_repo',
  'fetch_diff',
  'fetch_url',
  'web_search',
  'wikipedia_search',
  'github_pr_list',
  'github_pr_view',
  'github_pr_files',
  'github_pr_diff',
  'github_pr_comments',
  'github_pr_comment',
  'github_pr_create',
  'github_workflow_runs',
  'github_check_status',
  'draft_email',
  'queue_email',
  'send_email',
  'draft_post',
  'queue_post',
  'publish_post',
  'draft_connector_action',
  'request_tool_permission',
]);

const UNKNOWN_TOOL_ANNOTATIONS: ToolAnnotations = Object.freeze({
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
});

/**
 * Return complete behavioral hints for a built-in or dynamic tool. Dynamic
 * project scripts are intentionally conservative because their manifests do
 * not yet declare effects.
 */
export function annotationsForTool(name: string): ToolAnnotations {
  const canonical = canonicalToolName(name) as CanonicalToolName;
  const isKnown = Object.prototype.hasOwnProperty.call(TOOL_REGISTRY, canonical);
  const readOnly = READ_ONLY_TOOLS.has(canonical);
  if (!isKnown) return { ...UNKNOWN_TOOL_ANNOTATIONS };
  return {
    readOnlyHint: readOnly,
    destructiveHint: readOnly ? false : !NON_DESTRUCTIVE_MUTATIONS.has(canonical),
    idempotentHint: readOnly || IDEMPOTENT_MUTATIONS.has(canonical),
    openWorldHint: OPEN_WORLD_TOOLS.has(canonical),
  };
}
