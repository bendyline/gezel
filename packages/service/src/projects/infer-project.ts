import { opendir, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { homedir as osHomedir, tmpdir as osTmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type CreateProjectRequest,
  DEFAULT_INFERENCE_POLICY,
  type ExistingProjectRef,
  type ForbiddenContext,
  type FsEntry,
  type FsProbe,
  INFERRED_PROJECT_ORIGIN_PROPERTY,
  INFERRED_PROJECT_SOURCE_PROPERTY,
  INFERRED_PROJECT_WELL_KNOWN_PROPERTY,
  type InferOutcome,
  type InferProjectForPathRequest,
  type InferProjectForPathResponse,
  type InferencePlatform,
  type InferencePolicy,
  KeyedLock,
  type Project,
  type ProjectDetail,
  type WellKnownFolder,
  type WellKnownFolderInfo,
  type WellKnownFoldersResponse,
  compareKey,
  createLogger,
  forbiddenRootReason,
  inferProjectRoot,
  isAbsolutePath,
  isDocumentFileName,
  isSharedLibraryProject,
  normalizePath,
  parentOf,
  pathsEqual,
  projectManagedWorkspaceWritable,
  toInferencePlatform,
  wellKnownFolders,
} from '@bendyline/gezel';
import { activeMachineSharedHome } from '@bendyline/gezel/paths';
import { realpathNearest } from '../fs/safe-paths.js';
import type { Store } from '../fs/store.js';
import type { HistoryManager } from '../history/manager.js';

const log = createLogger('projects');

/**
 * Service side of document → project-folder inference. The rules are pure
 * and live in `@bendyline/gezel` (`project-inference/`); this module supplies
 * the real filesystem, the real home directory, and the project list, then
 * materializes the answer: reuse a project, create a read-only folder
 * project, or fall back to the Default project.
 *
 * Read-only by default comes for free: a created project has an external
 * `workingDir` and no `managedWorkspaceWritePolicy`, which
 * `projectManagedWorkspaceWritable` resolves to "gezels may not write".
 * Nothing here may set that policy.
 */

export class InferProjectError extends Error {
  constructor(
    message: string,
    readonly code: 'invalid_path' | 'path_not_found' | 'forbidden_root',
    readonly status: 400 | 403 | 404,
    readonly reason?: string,
  ) {
    super(message);
    this.name = 'InferProjectError';
  }
}

export interface InferProjectDeps {
  store: Store;
  /** The gezel home the store serves. */
  home: string;
  /** Creates a project exactly as `POST /api/projects` does. */
  createProject: (body: CreateProjectRequest) => Promise<ProjectDetail>;
  history?: HistoryManager;
  // Test seams. Production passes none of these; the daemon's own view of
  // the machine is the only authority, never a client-supplied home.
  platform?: NodeJS.Platform;
  homedir?: string;
  env?: NodeJS.ProcessEnv;
  tmpdir?: string;
  tempRoots?: string[];
  policy?: Partial<InferencePolicy>;
}

/** One creation at a time per folder, so two documents opened together share a project. */
const creationLocks = new KeyedLock();

const MAX_LISTED_ENTRIES = DEFAULT_INFERENCE_POLICY.maxEntriesPerDir;

function hasControlCharacters(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) < 0x20) return true;
  }
  return false;
}

async function realpathOrSelf(p: string): Promise<string> {
  return realpath(p).catch(() => p);
}

async function isDirectory(p: string): Promise<boolean> {
  return stat(p)
    .then((s) => s.isDirectory())
    .catch(() => false);
}

/**
 * List a directory, giving up (null) past `max` entries so a huge folder
 * costs one bounded read instead of a full scan.
 */
async function listBounded(path: string, max: number): Promise<FsEntry[] | null> {
  let dir: Awaited<ReturnType<typeof opendir>> | null = null;
  try {
    dir = await opendir(path);
    const out: FsEntry[] = [];
    for await (const entry of dir) {
      out.push({ name: entry.name, isDir: entry.isDirectory() });
      if (out.length > max) return null;
    }
    return out;
  } catch {
    return null;
  } finally {
    await dir?.close().catch(() => {});
  }
}

export function realFsProbe(max = MAX_LISTED_ENTRIES): FsProbe {
  return { listDir: (path) => listBounded(path, max) };
}

interface MachineView {
  platform: InferencePlatform;
  ctx: ForbiddenContext;
}

async function machineView(deps: InferProjectDeps): Promise<MachineView> {
  const platform = toInferencePlatform(deps.platform ?? process.platform);
  const env = deps.env ?? process.env;
  const home = await realpathOrSelf(deps.homedir ?? osHomedir());
  let userDirs: string | null = null;
  let cloudStorageEntries: string[] = [];
  if (platform === 'linux') {
    const configHome = env.XDG_CONFIG_HOME || join(home, '.config');
    userDirs = await readFile(join(configHome, 'user-dirs.dirs'), 'utf8').catch(() => null);
  }
  if (platform === 'darwin') {
    cloudStorageEntries = await readdir(join(home, 'Library', 'CloudStorage')).catch(() => []);
  }
  const external = deps.store.externalFolders;
  const ctx: ForbiddenContext = {
    platform,
    homedir: home,
    env,
    userDirs,
    cloudStorageEntries,
    tmpdir: await realpathOrSelf(deps.tmpdir ?? osTmpdir()),
    ...(deps.tempRoots ? { tempRoots: deps.tempRoots } : {}),
    gezelHome: await realpathOrSelf(deps.home),
    machineSharedHome: activeMachineSharedHome(env),
    externalFolders: {
      ...(external?.gezels ? { gezels: external.gezels } : {}),
      ...(external?.projects ? { projects: external.projects } : {}),
    },
  };
  return { platform, ctx };
}

/** Candidates that exist on disk, with realpath'd paths so they compare with realpath'd documents. */
async function existingWellKnownFolders(view: MachineView): Promise<WellKnownFolder[]> {
  const out: WellKnownFolder[] = [];
  for (const folder of wellKnownFolders(view.ctx)) {
    if (!(await isDirectory(folder.path))) continue;
    const real = normalizePath(await realpathOrSelf(folder.path), view.platform);
    if (out.some((f) => pathsEqual(f.path, real, view.platform))) continue;
    out.push({ ...folder, path: real });
  }
  return out;
}

async function existingProjectRefs(
  projects: readonly Project[],
  platform: InferencePlatform,
): Promise<ExistingProjectRef[]> {
  const refs: ExistingProjectRef[] = [];
  for (const p of projects) {
    if (!p.workingDir) continue;
    const base = { id: p.id, name: p.name, sharedLibrary: isSharedLibraryProject(p) };
    refs.push({ ...base, workingDir: p.workingDir });
    const real = await realpathOrSelf(p.workingDir);
    if (!pathsEqual(real, p.workingDir, platform)) refs.push({ ...base, workingDir: real });
  }
  return refs;
}

/**
 * `real` drives every rule and match. `lexical` is the caller's own spelling,
 * which a folder project stores: a hosted app or editor reads its project's
 * `workingDir` back and expects the path it asked for, not a symlink target.
 */
interface ResolvedTarget {
  real: string;
  lexical: string;
}

async function resolveTarget(
  rawPath: string,
  kind: 'document' | 'folder',
  platform: InferencePlatform,
): Promise<ResolvedTarget> {
  if (rawPath.length > 4096 || hasControlCharacters(rawPath)) {
    throw new InferProjectError('path is not a valid absolute path', 'invalid_path', 400);
  }
  if (!isAbsolutePath(rawPath, platform)) {
    throw new InferProjectError('path must be absolute', 'invalid_path', 400);
  }
  const lexical = normalizePath(rawPath, platform);
  if (kind === 'folder') {
    // A folder an application is about to create is a valid binding; a file is not.
    const kindOnDisk = await stat(rawPath)
      .then((s) => (s.isDirectory() ? 'dir' : 'other'))
      .catch(() => 'missing');
    if (kindOnDisk === 'other') {
      throw new InferProjectError('path is not a folder', 'invalid_path', 400);
    }
    const real = (await realpathNearest(rawPath)) ?? rawPath;
    return { real: normalizePath(real, platform), lexical };
  }
  // A document may not be saved yet, but the folder it would be saved in must exist.
  const parent = parentOf(rawPath, platform);
  if (!parent || !(await isDirectory(parent))) {
    throw new InferProjectError('the document folder was not found', 'path_not_found', 404);
  }
  const real = (await realpathNearest(rawPath)) ?? rawPath;
  return { real: normalizePath(real, platform), lexical };
}

async function defaultProject(store: Store): Promise<ProjectDetail> {
  const project = await store.getProject('default');
  if (!project) throw new Error('default project is missing');
  return project;
}

function wellKnownSummary(folder: WellKnownFolder | undefined) {
  if (!folder) return undefined;
  return {
    kind: folder.kind,
    label: folder.label,
    ...(folder.cloud ? { cloud: folder.cloud } : {}),
  };
}

function outcomeFolder(outcome: InferOutcome): WellKnownFolder | undefined {
  if (outcome.matchedBy === 'well-known') return outcome.folder;
  if (outcome.matchedBy === 'climb' || outcome.matchedBy === 'parent') return outcome.folder;
  return undefined;
}

export async function inferProjectForPath(
  deps: InferProjectDeps,
  request: InferProjectForPathRequest,
): Promise<InferProjectForPathResponse> {
  const kind = request.kind ?? 'document';
  const create = request.create !== false;
  const source = request.source ?? 'unknown';

  if (!request.path) {
    if (kind === 'folder') {
      throw new InferProjectError('path is required for a folder', 'invalid_path', 400);
    }
    const project = await defaultProject(deps.store);
    return {
      project,
      created: false,
      matchedBy: 'default',
      readOnly: !projectManagedWorkspaceWritable(project),
      reason: 'no-path',
      warnings: [],
    };
  }

  const view = await machineView(deps);
  const target = await resolveTarget(request.path, kind, view.platform);
  const projects = await deps.store.listProjects();
  const outcome = await inferProjectRoot(
    {
      path: target.real,
      kind,
      ctx: view.ctx,
      wellKnown: await existingWellKnownFolders(view),
      existing: await existingProjectRefs(projects, view.platform),
      policy: deps.policy,
    },
    realFsProbe(),
  );

  if (outcome.matchedBy === 'existing') {
    const project = (await deps.store.getProject(outcome.projectId)) ?? null;
    if (!project) throw new Error(`project ${outcome.projectId} disappeared during inference`);
    return {
      project,
      created: false,
      matchedBy: 'existing',
      root: outcome.root,
      name: project.name,
      readOnly: !projectManagedWorkspaceWritable(project),
      ...(outcome.sharedLibrary ? { sharedLibrary: true } : {}),
      warnings: outcome.warnings,
    };
  }

  if (outcome.matchedBy === 'default') {
    if (kind === 'folder') {
      throw new InferProjectError(
        'gezel does not create a project for this folder',
        'forbidden_root',
        403,
        outcome.reason,
      );
    }
    const project = await defaultProject(deps.store);
    return {
      project,
      created: false,
      matchedBy: 'default',
      readOnly: !projectManagedWorkspaceWritable(project),
      reason: outcome.reason,
      warnings: outcome.warnings,
    };
  }

  const folder = outcomeFolder(outcome);
  const summary = wellKnownSummary(folder);
  const root =
    kind === 'folder' && pathsEqual(outcome.root, target.real, view.platform)
      ? target.lexical
      : outcome.root;
  if (!create) {
    return {
      project: null,
      created: false,
      matchedBy: outcome.matchedBy,
      root,
      name: outcome.name,
      readOnly: true,
      ...(summary ? { wellKnown: summary } : {}),
      warnings: outcome.warnings,
    };
  }

  const lockKey = `${deps.home}\u0000${compareKey(outcome.root, view.platform)}`;
  return creationLocks.run(lockKey, async () => {
    // Another request may have created this folder's project while we waited.
    const fresh = await deps.store.listProjects();
    const raced = fresh.find(
      (p) =>
        p.workingDir &&
        (pathsEqual(p.workingDir, outcome.root, view.platform) ||
          pathsEqual(p.workingDir, root, view.platform)),
    );
    if (raced) {
      const project = (await deps.store.getProject(raced.id)) ?? null;
      if (project) {
        return {
          project,
          created: false,
          matchedBy: 'existing' as const,
          root,
          name: project.name,
          readOnly: !projectManagedWorkspaceWritable(project),
          ...(isSharedLibraryProject(project) ? { sharedLibrary: true } : {}),
          warnings: [],
        };
      }
    }

    let project: ProjectDetail | null = null;
    let adopted = false;
    // Folder callers (VS Code, the CLI) have always adopted an unbound
    // project of the same name, which recovers a folder renamed while it was
    // open. Document inference never does: it must not bind a user's own
    // project called "Documents" to their Documents folder.
    if (kind === 'folder') {
      const orphan = fresh.find(
        (p) =>
          !p.workingDir &&
          p.id !== 'default' &&
          !isSharedLibraryProject(p) &&
          p.name === outcome.name,
      );
      if (orphan) {
        project = await deps.store.updateProjectWorkingDir(orphan.id, root);
        adopted = true;
      }
    }
    if (!project) {
      project = await deps.createProject({
        name: outcome.name,
        description:
          request.description ??
          (folder && outcome.matchedBy === 'well-known'
            ? `Your ${folder.label} folder`
            : `Folder project for ${root}`),
        ...(request.about ? { about: request.about } : {}),
        ...(request.missionObjectives ? { missionObjectives: request.missionObjectives } : {}),
        mode: request.mode ?? 'solo',
        workingDir: root,
        ...(folder?.kind === 'downloads' ? { indexingEnabled: false } : {}),
      });
    }
    project = await deps.store.updateProject(project.id, {
      properties: {
        [INFERRED_PROJECT_ORIGIN_PROPERTY]: outcome.matchedBy,
        [INFERRED_PROJECT_SOURCE_PROPERTY]: source,
        ...(folder ? { [INFERRED_PROJECT_WELL_KNOWN_PROPERTY]: folder.kind } : {}),
      },
    });
    await deps.history
      ?.log({
        kind: 'project.inferred',
        projectId: project.id,
        summary: adopted
          ? `Linked project "${project.name}" to ${root}`
          : `Created project "${project.name}" for ${root}`,
        details: {
          matchedBy: outcome.matchedBy,
          root,
          source,
          created: !adopted,
          ...(folder ? { wellKnownKind: folder.kind } : {}),
        },
      })
      .catch((err: unknown) => {
        log.warn(`[projects] project.inferred history write failed: ${String(err)}`);
      });
    return {
      project,
      created: !adopted,
      matchedBy: outcome.matchedBy,
      root,
      name: outcome.name,
      readOnly: !projectManagedWorkspaceWritable(project),
      ...(summary ? { wellKnown: summary } : {}),
      warnings: outcome.warnings,
    };
  });
}

/** Well-known folders for a first-run "add a project for Documents / Pictures" offer. */
export async function listWellKnownFolders(
  deps: InferProjectDeps,
): Promise<WellKnownFoldersResponse> {
  const view = await machineView(deps);
  const projects = await deps.store.listProjects();
  const refs = await existingProjectRefs(projects, view.platform);
  const folders: WellKnownFolderInfo[] = [];
  for (const candidate of wellKnownFolders(view.ctx)) {
    const exists = await isDirectory(candidate.path);
    // Every standard folder is reported; speculative cloud locations only when present.
    if (
      !exists &&
      candidate.source !== 'default' &&
      candidate.source !== 'xdg' &&
      candidate.source !== 'env'
    ) {
      continue;
    }
    const path = exists
      ? normalizePath(await realpathOrSelf(candidate.path), view.platform)
      : candidate.path;
    if (folders.some((f) => pathsEqual(f.path, path, view.platform))) continue;
    const info: WellKnownFolderInfo = {
      kind: candidate.kind,
      label: candidate.label,
      path,
      ...(candidate.cloud ? { cloud: candidate.cloud } : {}),
      exists,
    };
    if (exists) {
      const entries = await listBounded(path, MAX_LISTED_ENTRIES);
      if (entries) {
        info.itemCount = entries.length;
        info.documentCount = entries.filter((e) => !e.isDir && isDocumentFileName(e.name)).length;
      } else {
        info.truncated = true;
      }
    }
    const match = refs.find((r) => pathsEqual(r.workingDir, path, view.platform));
    if (match) {
      info.projectId = match.id;
      if (match.sharedLibrary) info.sharedLibrary = true;
    }
    const forbidden = forbiddenRootReason(path, view.ctx);
    if (forbidden) info.forbidden = forbidden;
    folders.push(info);
  }
  return { folders };
}
