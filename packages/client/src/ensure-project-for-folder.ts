import { realpath } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import type { CreateProjectRequest } from '@bendyline/gezel';
import { GezelApiError } from './api-error.js';
import type { GezelClient } from './client.js';

export interface EnsureProjectForFolderOptions {
  /** `crew` (VS Code) or `solo` (CLI, app SDK). */
  mode: 'crew' | 'solo';
  /** Stamped on a project the daemon creates: `vscode`, `cli`, `app-sdk`… */
  source: string;
  description?: string;
  about?: string;
  missionObjectives?: string;
}

export interface EnsureProjectForFolderResult {
  projectId: string;
  created: boolean;
}

/**
 * Find or create the project bound to a folder the user explicitly opened.
 * The one implementation behind VS Code, the CLI, and the app SDK.
 *
 * Asks the daemon (`POST /api/projects/infer-for-path`, `kind: 'folder'`),
 * which reuses a project whose workingDir is this folder, adopts an unbound
 * project of the same name, or creates one — and refuses folders gezel must
 * never own (a drive root, the home folder, AppData), answering 403
 * `forbidden_root`, which this helper rethrows. Against an older daemon
 * without that route it falls back to the original client-side algorithm.
 */
export async function ensureProjectForFolder(
  client: Pick<
    GezelClient,
    'inferProjectForPath' | 'listProjects' | 'setProjectWorkingDir' | 'createProject'
  >,
  folder: string,
  opts: EnsureProjectForFolderOptions,
): Promise<EnsureProjectForFolderResult> {
  const requested = resolve(folder);
  const workingDir = await realpath(requested).catch(() => requested);
  // Partial clients (older embedders, test doubles) keep the original behaviour.
  if (typeof client.inferProjectForPath !== 'function') {
    return legacyEnsureProjectForFolder(client, requested, workingDir, opts);
  }
  try {
    const res = await client.inferProjectForPath({
      path: workingDir,
      kind: 'folder',
      mode: opts.mode,
      source: opts.source,
      ...(opts.description ? { description: opts.description } : {}),
      ...(opts.about ? { about: opts.about } : {}),
      ...(opts.missionObjectives ? { missionObjectives: opts.missionObjectives } : {}),
    });
    if (!res.project) throw new Error('the daemon returned no project for this folder');
    return { projectId: res.project.id, created: res.created };
  } catch (err) {
    if (!(err instanceof GezelApiError) || err.status !== 404 || isPathNotFound(err)) throw err;
    return legacyEnsureProjectForFolder(client, requested, workingDir, opts);
  }
}

/** A 404 that is the daemon saying "that folder does not exist", not "unknown route". */
function isPathNotFound(err: GezelApiError): boolean {
  const details = err.details as { code?: unknown } | undefined;
  return details?.code === 'path_not_found';
}

/**
 * The pre-inference algorithm: exact workingDir match (on the path as given
 * or its realpath), then a same-name project with no folder, then create.
 */
async function legacyEnsureProjectForFolder(
  client: Pick<GezelClient, 'listProjects' | 'setProjectWorkingDir' | 'createProject'>,
  requested: string,
  workingDir: string,
  opts: EnsureProjectForFolderOptions,
): Promise<EnsureProjectForFolderResult> {
  const fold = (p: string): string =>
    process.platform === 'win32' || process.platform === 'darwin' ? p.toLowerCase() : p;
  const wanted = new Set([fold(requested), fold(workingDir)]);
  const same = (candidate: string | undefined): boolean =>
    !!candidate && wanted.has(fold(candidate));
  const { projects } = await client.listProjects();
  const exact = projects.find((project) => same(project.workingDir));
  if (exact) return { projectId: exact.id, created: false };
  const name = basename(workingDir) || 'workspace';
  const orphan = projects.find((project) => !project.workingDir && project.name === name);
  if (orphan) {
    await client.setProjectWorkingDir(orphan.id, workingDir);
    return { projectId: orphan.id, created: false };
  }
  const body: CreateProjectRequest = {
    name,
    description: opts.description ?? `Workspace at ${workingDir}`,
    ...(opts.about ? { about: opts.about } : {}),
    ...(opts.missionObjectives ? { missionObjectives: opts.missionObjectives } : {}),
    mode: opts.mode,
    workingDir,
  };
  const created = await client.createProject(body);
  return { projectId: created.id, created: true };
}
