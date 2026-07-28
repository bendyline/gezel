import type {
  CatalogItemDetail,
  CatalogItemSummary,
  CatalogItemVersionInfo,
  CatalogKind,
  ToolsetManifest,
} from '@bendyline/gezel';
import { BUILTIN_TOOLSET_ICONS } from './builtin-toolset-icons.js';
import type { CatalogSource } from './source.js';

const BUILTIN_VERSION = '1.0.0';
const BUILTIN_RELEASED_AT = '2026-04-25T00:00:00Z';

/**
 * ─ Built-in toolsets ────────────────────────────────────────────────
 *
 * The main MCP server (`@bendyline/gezel-mcp`) registers 90+ tools.
 * Sending all of them on every chat turn fills 10K+ input tokens of
 * tool schemas before the user's message is even read — enough to
 * trip OpenAI Tier-1 TPM caps on a fresh "hello?" turn. The fix is
 * to bucket those tools into named groups and only expose the groups
 * a given gezel actually needs.
 *
 * Each group surfaces in the catalog as a synthetic toolset manifest
 * with `runtime.kind === 'builtin'`. A gezel's toolsets can install /
 * uninstall these groups exactly like third-party MCP toolsets;
 * `ChatManager` reads the per-gezel toolsets, expands the groups to a
 * tool-name allowlist, and hands it to `McpBridgePool` which strips
 * everything else before serializing for the model.
 *
 * Membership is the single source of truth for role defaults
 * (`role-tool-filter.ts` references group ids, not tool names) and
 * for the picker UI. New tools added to the MCP server should be
 * dropped into a relevant group here so they reach gezels at all.
 *
 * Catalog id format: `builtin.<group-id>` (e.g. `builtin.workspace-fs-read`).
 * The prefix keeps us out of the third-party id namespace.
 */
export interface BuiltinToolsetGroup {
  id: string;
  name: string;
  description: string;
  tools: string[];
}

export const BUILTIN_TOOLSETS: BuiltinToolsetGroup[] = [
  {
    id: 'memory',
    name: 'Memory',
    description:
      "Persistent notes a gezel can search, recall, and write back. Backed by the gezel's per-day memory files plus a vector index.",
    tools: ['search_memory', 'save_memory', 'list_memories'],
  },
  {
    id: 'workspace-fs-read',
    name: 'Workspace File Reading',
    description:
      "Read, list, search, and diff files in the project workspace. Mirrors Node's `fs` reads plus content/glob search. Diagnose-only — pair with `workspace-fs-write` to actually mutate.",
    tools: ['readdir', 'readFile', 'stat', 'validate', 'search_files', 'find_files', 'diff_files'],
  },
  {
    id: 'code-intel',
    name: 'Code Intelligence',
    description:
      "Navigate and understand the codebase via the workspace index instead of reading whole files: outline a file's symbols, jump to a definition, read just one symbol's source, find usages, and map the repo. Every result carries line ranges so the model reads only the span it needs — a big context saver for small/medium local models.",
    tools: [
      'outline_file',
      'find_symbol',
      'read_symbol',
      'find_references',
      'map_repo',
      'search_code',
      'file_review',
      'list_file_issues',
    ],
  },
  {
    id: 'security-intel',
    name: 'Security Intelligence',
    description:
      'Static security analysis pushed into the index and reused as tools: run a whole-repo scan (dependency inventory + opportunistic semgrep/osv-scanner/gitleaks), get a posture overview with candidate systemic themes, list findings by severity/category, map the attack surface (entry points, routes, auth boundaries, secret touchpoints), inventory dependencies with advisories, and trace import-graph reachability for source→sink flows. The substrate for a deep, systemic security review.',
    tools: [
      'security_scan',
      'security_overview',
      'scan_findings',
      'map_attack_surface',
      'list_dependencies',
      'trace_taint',
    ],
  },
  {
    id: 'doc-intel',
    name: 'Document Intelligence',
    description:
      'Search and read office documents (Word, PDF, PowerPoint, Excel) that gezel has converted to markdown in the index. Keyword-search across a document corpus and read any document as scannable markdown on demand — no need to wrestle with binary files.',
    tools: ['search_docs', 'read_doc_as_markdown'],
  },
  {
    id: 'image-intel',
    name: 'Image Intelligence',
    description:
      'Navigate an indexed image library: search images by filename/caption/dimensions, summarize a folder of images for review or reorganizing, and find visually similar images. Built for folder-operations over large image collections.',
    tools: ['search_images', 'find_similar_images', 'describe_folder'],
  },
  {
    id: 'entity-intel',
    name: 'Entity Intelligence',
    description:
      'Cross-file entities the index resolved from structured metadata — email senders, document parties — and where each appears. Ask "every email from X" or "every contract naming Y" and get a dated, cross-file view.',
    tools: ['find_entity', 'list_entity_mentions'],
  },
  {
    id: 'workspace-fs-write',
    name: 'Workspace File Writing',
    description:
      'Create, write, surgically edit, rename, and delete files in the project workspace. Always paired with `workspace-fs-read` for the roles that build (developer, designer, reviewer); split out so coordinator roles (voorman) can investigate without being tempted to do the building themselves.',
    tools: [
      'writeFile',
      'appendToFile',
      'replaceInFile',
      'replaceLines',
      'applyPatch',
      'insertAtMarker',
      'copy_artifact_to_workspace',
      'mkdir',
      'rm',
      'rename',
    ],
  },
  {
    id: 'archives',
    name: 'Archive Tools',
    description: 'List and extract zip / tar archives in the workspace.',
    tools: ['list_archive', 'extract_archive'],
  },
  {
    id: 'documents',
    name: 'Documents',
    description:
      'Cross-project shared library — mission docs, guidelines, and any markdown the user wants every gezel to be able to find.',
    tools: [
      'list_documents',
      'read_document',
      'write_document',
      'delete_document',
      'search_documents',
    ],
  },
  {
    id: 'artifacts',
    name: 'Project Artifacts',
    description:
      'Project-scoped read-write outputs (reports, scratch files, scripts a gezel produces, and large outputs auto-saved by tools that exceed the inline cap).',
    tools: ['list_artifacts', 'read_artifact', 'write_artifact', 'grep_artifact'],
  },
  {
    id: 'tasks',
    name: 'Task Management',
    description:
      'Create, assign, advance, and report on tasks. The full task surface including notes, steps, and child instance spawning.',
    tools: [
      'list_tasks',
      'get_task',
      'list_craftbooks',
      'suggest_craftbook',
      'import_skill',
      'create_task',
      'start_plan',
      'invoke_craftbook',
      'update_task',
      'set_outcomes',
      'verify_outcome',
      'add_verification_step',
      'set_task_status',
      'activate_task',
      'list_task_children',
      'add_task_step',
      'advance_task_step',
      'assign_task',
      'read_task_notes',
      'write_task_note',
      'spawn_task_instances',
    ],
  },
  {
    id: 'craftbooks',
    name: 'Craftbook Authoring',
    description:
      "Read and edit a craftbook's structure — add/update/remove/reorder steps, set the entry step, rewire routing (next/branches/gate/advanceWhen/terminal), and create or replace whole templates. The unified surface targets either a task's embedded craftbook or a standalone local template. Pair with `tasks` for the voorman's full build-and-curate workflow.",
    tools: [
      'craftbook_read',
      'craftbook_write',
      'craftbook_add_step',
      'craftbook_update_step',
      'set_step_deliverable',
      'craftbook_remove_step',
      'craftbook_reorder_steps',
      'craftbook_set_entry',
      'craftbook_update',
      'craftbook_create',
      'craftbook_replace',
      'export_task_craftbook',
    ],
  },
  {
    id: 'tasks-readonly',
    name: 'Task Visibility',
    description:
      'Read-only task surface for delegation roles — list tasks, inspect a specific task, read its notes. The "ping projects to see status" subset, without any of the mutation tools (create, update, assign, status, advance) that belong to the assignee or voorman. Pair with `team-management` for a complete delegation surface.',
    tools: ['list_tasks', 'get_task', 'list_craftbooks', 'suggest_craftbook', 'read_task_notes'],
  },
  {
    id: 'craftbook-launch',
    name: 'Craftbook Launcher',
    description:
      'Procedure-first task launch surface for coordinators: rank applicable craftbooks and invoke a selected recipe after its required setup is ready.',
    tools: ['list_craftbooks', 'suggest_craftbook', 'invoke_craftbook'],
  },
  {
    id: 'team-management',
    name: 'Team & Project Management',
    description:
      'Spin up other gezels, message them, browse the gilde of templates, and manage projects + project membership. The Meester surface.',
    tools: [
      'list_gezels',
      'create_gezel',
      'update_gezel',
      'ensure_gezel',
      'create_gezel_from_gilde',
      'message_gezel',
      'list_projects',
      'start_project',
      'start_job',
      'fetch_repo',
      'fetch_diff',
      'update_project',
      'list_gilde',
      'list_project_types',
      'apply_project_type',
      'start_project_from_type',
      'export_project_type',
      'import_project_type',
      'list_project_local_gezels',
      'list_project_gezels',
      'add_gezel_to_project',
      'remove_gezel_from_project',
    ],
  },
  {
    id: 'audio',
    name: 'Audio',
    description:
      'Speech-to-text (`transcribe_audio`) and text-to-speech (`synthesize_speech`). Heavy — only useful for gezels that do voice work.',
    tools: ['transcribe_audio', 'synthesize_speech'],
  },
  {
    id: 'code-execution',
    name: 'Code Execution',
    description:
      'Run Node scripts, npm install, run package scripts, invoke npx. Sandboxed to the project workspace.',
    tools: [
      'run_nodejs_script',
      'derive_file',
      'npm_install',
      'run_npx',
      'run_script',
      'run_package_script',
      'list_packages',
      'list_package_scripts',
      'list_scripts',
      'get_script_run',
    ],
  },
  {
    id: 'browser-automation',
    name: 'Browser Automation',
    description:
      'Drive a headless Chromium via Playwright scripts. Heavy — only useful for gezels that genuinely need browser work.',
    tools: ['run_playwright_script'],
  },
  {
    id: 'git',
    name: 'Git & GitHub',
    description:
      'Run read-only git commands inside the project workspace, inspect GitHub pull requests, post review comments, open PRs, and check workflow status for linked project repositories.',
    tools: [
      'run_git',
      'github_pr_list',
      'github_pr_view',
      'github_pr_files',
      'github_pr_diff',
      'github_pr_comments',
      'github_pr_comment',
      'github_pr_create',
      'github_workflow_runs',
      'github_check_status',
    ],
  },
  {
    id: 'web',
    name: 'Web Access',
    description:
      'Search the web (when a keyed backend like Brave is configured) or Wikipedia, fetch URL contents, and find interactive elements on a browser-controlled page (after a Playwright navigate / click / type). `web_search` only registers when a real keyed backend is configured; `wikipedia_search` only registers for non-cloud models (cloud models already have Wikipedia in training).',
    tools: ['web_search', 'wikipedia_search', 'fetch_url', 'browser_find_page_element'],
  },
  {
    id: 'images',
    name: 'Image Tools',
    description:
      'Render charts/diagrams, read and describe existing images, and generate new images via the configured image model.',
    tools: [
      'render_image',
      'read_image_as_base64',
      'generate_image',
      'describe_image',
      'read_image_metadata',
    ],
  },
  {
    id: 'videos',
    name: 'Video Tools',
    description: 'Generate short video clips via the configured local video model (LTX / WAN).',
    tools: ['generate_video'],
  },
  {
    id: 'history',
    name: 'Audit & History',
    description:
      'Search the install-wide audit log of who did what and when, plus past chat transcripts.',
    tools: ['search_history', 'search_sessions'],
  },
  {
    id: 'handboek',
    name: 'Handboek',
    description:
      "Consult gezel's built-in documentation for meta questions about gezel itself — roles, craftbooks, projects, memory, models, setup. In every role's kit so a gezel answers 'how does gezel work?' from the real docs instead of guessing.",
    tools: ['how_do_i'],
  },
  {
    id: 'interaction',
    name: 'User Interaction',
    description:
      'Pose a structured question mid-turn — to the user (`ask_user_question`), to a specific gezel (`ask_gezel`), or to a role-shaped specialist (`ask_specialist`) — instead of guessing.',
    tools: ['ask_user_question', 'ask_gezel', 'ask_specialist'],
  },
  {
    id: 'role-delegation',
    name: 'Role Delegation (downward)',
    description:
      'Hand work to a teammate by ROLE instead of by name: `delegate_<role>` (async hand-off) and `consult_<role>` (sync question) for each doer role — developer, designer, reviewer, planner, researcher, builder, writer, image-generator. The target lives in the tool identity (no free-text `gezel`/`role` argument), which small/medium local models route far more reliably. Each resolves to the project gezel of that role, creating one on demand. Orchestrator (meester/voorman) surface; gated by the `tools.gezels-as-roles` behavior.',
    tools: [
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
    ],
  },
  {
    id: 'role-delegation-escalation',
    name: 'Role Delegation (escalation)',
    description:
      'Reach a coordination role by ROLE: `delegate_voorman` / `consult_voorman` and `delegate_meester` / `consult_meester`. The escalation counterpart to `role-delegation` — lets a specialist hand work or questions UP to their voorman or the meester. Gated by the `tools.gezels-as-roles` behavior.',
    tools: ['delegate_voorman', 'consult_voorman', 'delegate_meester', 'consult_meester'],
  },
];

const BUILTIN_BY_ID = new Map(BUILTIN_TOOLSETS.map((g) => [g.id, g]));

/** Resolve a group by its `id` (e.g. `'workspace-fs-read'`). */
export function getBuiltinToolset(id: string): BuiltinToolsetGroup | undefined {
  return BUILTIN_BY_ID.get(id);
}

/**
 * Inverse map: tool name → group it belongs to. Built once at module
 * load (~60 entries). Used by the auto-injected `## Tools available
 * this turn` block in the system prompt to bucket tool names into
 * named groups so the model sees a structured listing rather than a
 * flat alphabet soup. Tools not in any group (third-party MCP servers
 * the user installed) get classified as "other" by the consumer.
 *
 * If two groups ever name the same tool, the FIRST group in
 * `BUILTIN_TOOLSETS` wins (matches the Map insertion-order iteration).
 * Deliberate subset groups such as `tasks-readonly` may duplicate a
 * strict slice of their base group; other duplication is a manifest bug
 * worth surfacing rather than silently resolving here.
 */
export const BUILTIN_TOOL_TO_GROUP = new Map<string, BuiltinToolsetGroup>(
  BUILTIN_TOOLSETS.flatMap((g) => g.tools.map((toolName) => [toolName, g] as const)),
);

/** Catalog id format: `builtin.<group-id>`. */
export function builtinCatalogId(groupId: string): string {
  return `builtin.${groupId}`;
}

const SOURCE_ID = 'builtin';

function manifestForGroup(g: BuiltinToolsetGroup): ToolsetManifest {
  return {
    schemaVersion: 1,
    kind: 'toolset',
    id: builtinCatalogId(g.id),
    name: g.name,
    description: g.description,
    tags: ['built-in'],
    maintainer: { name: 'Gezel' },
    version: BUILTIN_VERSION,
    releasedAt: BUILTIN_RELEASED_AT,
    logo: 'icon.svg',
    tools: g.tools.map((name) => ({ name, description: '' })),
    runtime: { kind: 'builtin', toolsetGroupId: g.id },
    config: [],
    availableVersions: [BUILTIN_VERSION],
  };
}

/**
 * Catalog source that exposes the BUILTIN_TOOLSETS as installable
 * toolsets. Composed alongside `BundledSource` in `CatalogService`.
 */
export class BuiltinToolsetsSource implements CatalogSource {
  readonly id = SOURCE_ID;
  readonly label = 'Built-in';

  async listKinds(): Promise<CatalogKind[]> {
    return ['toolset'];
  }

  async list(kind: CatalogKind): Promise<CatalogItemSummary[]> {
    if (kind !== 'toolset') return [];
    return BUILTIN_TOOLSETS.map((g) => {
      const manifest = manifestForGroup(g);
      return {
        sourceId: this.id,
        kind,
        manifest,
        ...(BUILTIN_TOOLSET_ICONS[g.id] ? { iconSvg: BUILTIN_TOOLSET_ICONS[g.id] } : {}),
      };
    });
  }

  async get(kind: CatalogKind, id: string, version?: string): Promise<CatalogItemDetail | null> {
    if (kind !== 'toolset') return null;
    if (version !== undefined && version !== BUILTIN_VERSION) return null;
    const groupId = id.startsWith('builtin.') ? id.slice('builtin.'.length) : null;
    if (!groupId) return null;
    const g = BUILTIN_BY_ID.get(groupId);
    if (!g) return null;
    const manifest = manifestForGroup(g);
    return {
      sourceId: this.id,
      kind,
      manifest,
      ...(BUILTIN_TOOLSET_ICONS[g.id] ? { iconSvg: BUILTIN_TOOLSET_ICONS[g.id] } : {}),
    };
  }

  async listVersions(kind: CatalogKind, id: string): Promise<CatalogItemVersionInfo[]> {
    if (kind !== 'toolset') return [];
    const groupId = id.startsWith('builtin.') ? id.slice('builtin.'.length) : null;
    if (!groupId || !BUILTIN_BY_ID.has(groupId)) return [];
    return [{ version: BUILTIN_VERSION, releasedAt: BUILTIN_RELEASED_AT, yanked: false }];
  }

  async readItemFile(
    kind: CatalogKind,
    id: string,
    relPath: string,
    _version?: string,
  ): Promise<Buffer | null> {
    if (kind !== 'toolset' || relPath !== 'icon.svg') return null;
    if (!id.startsWith('builtin.')) return null;
    const groupId = id.slice('builtin.'.length);
    const svg = BUILTIN_TOOLSET_ICONS[groupId];
    if (!svg) return null;
    return Buffer.from(svg, 'utf8');
  }
}
