import { readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type {
  CatalogItemSummary,
  Craftbook,
  CraftbookRequirementContext,
  CraftbookTemplateManifest,
  CraftbookToolsetNeed,
  ProjectDetail,
  ProjectType,
  ToolsetsScope,
} from '@bendyline/gezel';
import {
  CraftbookTemplateManifestSchema,
  craftbookRequirementsMet,
  unmetToolsets,
} from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import type { Store } from '../fs/store.js';

const CODEBASE_FILES = new Set([
  '.git',
  'package.json',
  'pnpm-workspace.yaml',
  'tsconfig.json',
  'cargo.toml',
  'go.mod',
  'pyproject.toml',
  'requirements.txt',
  'gemfile',
  'pom.xml',
  'build.gradle',
  'settings.gradle',
  'composer.json',
  'mix.exs',
  'makefile',
  'cmakelists.txt',
]);
const CODEBASE_DIRS = new Set([
  'src',
  'app',
  'apps',
  'lib',
  'libs',
  'packages',
  'crates',
  'cmd',
  'internal',
  'test',
  'tests',
]);
const CODE_EXTENSIONS = new Set([
  '.c',
  '.cc',
  '.cpp',
  '.cs',
  '.css',
  '.ex',
  '.exs',
  '.go',
  '.h',
  '.hpp',
  '.html',
  '.java',
  '.js',
  '.jsx',
  '.kt',
  '.kts',
  '.php',
  '.py',
  '.rb',
  '.rs',
  '.scala',
  '.swift',
  '.ts',
  '.tsx',
  '.vue',
]);

interface WorkspaceEntryShape {
  name: string;
  isDirectory(): boolean;
}

/** The narrow GitManager surface needed to resolve the checkout's live branch. */
export interface ProjectGitStatusReader {
  status(project: ProjectDetail): Promise<{ branch?: string }>;
}

/** Pure root-level signal used by the project-aware craftbook filter. */
export function workspaceEntriesLookLikeCodebase(
  entries: ReadonlyArray<WorkspaceEntryShape>,
): boolean {
  return entries.some((entry) => {
    const name = entry.name.toLowerCase();
    if (CODEBASE_FILES.has(name)) return true;
    if (entry.isDirectory() && CODEBASE_DIRS.has(name)) return true;
    if (!entry.isDirectory() && CODE_EXTENSIONS.has(extname(name))) return true;
    return !entry.isDirectory() && (name.endsWith('.sln') || name.endsWith('.csproj'));
  });
}

/**
 * Best-effort, bounded detection for a workspace that already contains a
 * codebase. Root markers catch normal repositories immediately; one shallow
 * pass also handles a folder whose actual project lives one directory down.
 */
export async function projectHasEstablishedCodebase(
  store: Store,
  projectId: string,
): Promise<boolean> {
  if (!projectId) return false;
  const base = await store.projectWorkspaceDir(projectId).catch(() => null);
  if (!base) return false;
  const root = await readdir(base, { withFileTypes: true }).catch(() => []);
  if (workspaceEntriesLookLikeCodebase(root)) return true;

  const folders = root
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .slice(0, 24);
  for (const folder of folders) {
    const children = await readdir(join(base, folder.name), { withFileTypes: true }).catch(
      () => [],
    );
    if (workspaceEntriesLookLikeCodebase(children)) return true;
  }
  return false;
}

/**
 * Build the requirement-evaluation context for a project. When a git status
 * reader is available, its checkout HEAD is authoritative — the user may
 * switch branches outside Gezel and the branch chip already reflects that
 * live state. Stored `project.github.branch` is only a fallback for callers
 * that cannot inspect the checkout or when git status fails.
 */
export async function craftbookContextForProject(
  store: Store,
  projectId: string,
  git?: ProjectGitStatusReader,
): Promise<CraftbookRequirementContext> {
  const project = await store.getProject(projectId).catch(() => null);
  let branch = project?.github?.branch ?? null;
  if (project && git) {
    try {
      branch = (await git.status(project)).branch ?? null;
    } catch {
      // Keep the stored fallback only when live status itself is unavailable.
    }
  }
  return {
    hasGitHub: !!project?.github?.url,
    branch,
  };
}

/**
 * The catalog craftbooks applicable to a project — those whose
 * `requirements` the project's GitHub/branch state satisfies. Shared by
 * the rail (HTTP route) and the terminal command launcher so both offer
 * exactly the same set, and a non-applicable craftbook (e.g. Pull Request
 * Review on a non-GitHub project) is neither shown nor recognized.
 */
export async function listApplicableCraftbooks(
  catalog: CatalogService,
  store: Store,
  projectId: string,
  opts: {
    establishedCodebase?: boolean;
    git?: ProjectGitStatusReader;
    requirementContext?: CraftbookRequirementContext;
  } = {},
): Promise<CatalogItemSummary[]> {
  const items = await catalog.list('craftbook-template').catch(() => []);
  const ctx =
    opts.requirementContext ?? (await craftbookContextForProject(store, projectId, opts.git));
  const establishedCodebase =
    opts.establishedCodebase ?? (await projectHasEstablishedCodebase(store, projectId));
  return items.filter(
    (it) =>
      it.manifest.kind === 'craftbook-template' &&
      craftbookRequirementsMet(it.manifest.requirements, ctx) &&
      !(establishedCodebase && it.manifest.role === 'project-starter'),
  );
}

/**
 * The ids of applicable craftbooks "suggested" for a project type — those
 * whose manifest `tags` intersect the type's curated `craftbookTags`. Returns
 * an empty list when no type resolves (the rail then shows the full list, as
 * before). Curated + deterministic: relevance is explainable as a shared tag,
 * and detection-free books with rich tags surface without any per-book config.
 */
export function suggestedCraftbookIdsForType(
  items: CatalogItemSummary[],
  type: ProjectType | null | undefined,
): string[] {
  if (!type) return [];
  const wanted = new Set(type.craftbookTags.map((t) => t.toLowerCase()));
  const out: string[] = [];
  for (const it of items) {
    if (it.manifest.kind !== 'craftbook-template') continue;
    const tags = it.manifest.tags ?? [];
    if (tags.some((t) => wanted.has(t.toLowerCase()))) out.push(it.manifest.id);
  }
  return out;
}

/**
 * Present a runtime project-local craftbook in the catalog-summary shape
 * the launcher rail renders. Null when the book can't satisfy the
 * template-manifest schema (e.g. an id outside the catalog id grammar) —
 * such books stay invocable by id, they just don't join the rail.
 */
export function craftbookTemplateManifestFromRuntime(
  book: Craftbook,
): CraftbookTemplateManifest | null {
  const parsed = CraftbookTemplateManifestSchema.safeParse({
    schemaVersion: 1,
    kind: 'craftbook-template',
    id: book.id,
    name: book.name,
    description: book.description ?? '',
    tags: [],
    maintainer: { name: 'project' },
    version: book.version ?? '1.0.0',
    releasedAt: book.updatedAt,
    about: book.description ?? book.name,
    steps: book.steps,
    entryStepId: book.entryStepId,
    ...(book.basedOn ? { basedOn: book.basedOn } : {}),
    ...(book.plan ? { plan: book.plan } : {}),
    ...(book.defaultAssignee ? { defaultAssignee: book.defaultAssignee } : {}),
    ...(book.triggers ? { triggers: book.triggers } : {}),
    ...(book.hooks ? { hooks: book.hooks } : {}),
    ...(book.scripts ? { scripts: book.scripts } : {}),
    ...(book.paramSchema ? { paramSchema: book.paramSchema } : {}),
    ...(book.command ? { command: book.command } : {}),
    ...(book.requirements ? { requirements: book.requirements } : {}),
    ...(book.runModes ? { runModes: book.runModes } : {}),
    ...(book.toolsets ? { toolsets: book.toolsets } : {}),
  });
  return parsed.success ? parsed.data : null;
}

/**
 * Project-local craftbooks (workspace `.gezel/craftbooks/`) in
 * catalog-summary shape, requirement-filtered like the catalog listing.
 * The rail merges these OVER same-id catalog entries — mirroring the
 * task resolver's project-shadows-catalog precedence.
 */
export async function projectCraftbookSummaries(
  store: Store,
  projectId: string,
  opts: {
    git?: ProjectGitStatusReader;
    requirementContext?: CraftbookRequirementContext;
  } = {},
): Promise<CatalogItemSummary[]> {
  const summaries = await store.listProjectCraftbooks(projectId).catch(() => []);
  if (summaries.length === 0) return [];
  const ctx =
    opts.requirementContext ?? (await craftbookContextForProject(store, projectId, opts.git));
  const out: CatalogItemSummary[] = [];
  for (const s of summaries) {
    const book = await store.getProjectCraftbook(projectId, s.id).catch(() => null);
    if (!book) continue;
    const manifest = craftbookTemplateManifestFromRuntime(book);
    if (!manifest) continue;
    if (!craftbookRequirementsMet(manifest.requirements, ctx)) continue;
    out.push({ sourceId: 'project', kind: 'craftbook-template', manifest });
  }
  return out;
}

/**
 * The ids of every toolset installed and visible to a project's
 * craftbooks. Gathers the `shared` + `system` scopes and, when supplied,
 * the current project scope. The launcher isn't gezel-scoped, so per-gezel
 * toolsets remain out of frame. Used to compute which declared toolsets a
 * craftbook is still missing. Distinct from `requirements`: a missing
 * toolset never hides the craftbook — it surfaces a "needs setup" affordance.
 */
export async function installedToolsetIds(store: Store, projectId?: string): Promise<Set<string>> {
  const scopes: ToolsetsScope[] = [
    { kind: 'shared' },
    { kind: 'system' },
    ...(projectId ? ([{ kind: 'project', projectId }] satisfies ToolsetsScope[]) : []),
  ];
  const ids = new Set<string>();
  for (const scope of scopes) {
    const installed = await store.listInstalledToolsets(scope).catch(() => []);
    for (const t of installed) ids.add(t.toolsetId);
  }
  return ids;
}

/**
 * For each applicable craftbook, the *required* toolsets it declares that
 * aren't installed — keyed by craftbook id, only present when non-empty.
 * The launcher reads this to render the install/config affordance before
 * the craftbook can run. `optional` toolsets are intentionally excluded
 * (they're hints, never blockers).
 */
export async function missingToolsetsForCraftbooks(
  store: Store,
  items: CatalogItemSummary[],
  projectId?: string,
): Promise<Record<string, CraftbookToolsetNeed[]>> {
  const installed = await installedToolsetIds(store, projectId);
  const out: Record<string, CraftbookToolsetNeed[]> = {};
  for (const it of items) {
    if (it.manifest.kind !== 'craftbook-template') continue;
    const missing = unmetToolsets(it.manifest.toolsets, installed);
    if (missing.length > 0) out[it.manifest.id] = missing;
  }
  return out;
}
