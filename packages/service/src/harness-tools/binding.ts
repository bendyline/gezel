import { stat } from 'node:fs/promises';
import {
  type HarnessBoundProject,
  type HarnessClientId,
  type HarnessUnboundReason,
  type ResolvedHarnessToolsConfig,
  projectManagedWorkspaceWritable,
} from '@bendyline/gezel';
import type { Store } from '../fs/store.js';
import {
  type InferProjectDeps,
  InferProjectError,
  inferProjectForPath,
} from '../projects/infer-project.js';

export type HarnessBinding =
  | { project: HarnessBoundProject; folder?: string }
  | { project: null; unboundReason: HarnessUnboundReason; folder?: string };

export class HarnessBindingError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404,
    readonly code: 'project_not_found' | 'invalid_folder',
  ) {
    super(message);
    this.name = 'HarnessBindingError';
  }
}

/**
 * Which Gezel project an outside AI app works in. An explicit project id
 * wins (Claude Desktop has no folder; VS Code's extension already resolved
 * one). Otherwise the folder decides: a project that already contains it is
 * reused, and under "Add to Gezel" a new read-only folder project is made
 * for exactly that folder. That project has no lead gezel, never adopts an
 * unbound project of the same name, and never climbs to a parent folder,
 * because the person did not pick this folder in Gezel. A folder Gezel never
 * owns (home, a drive root) binds no project.
 */
export async function resolveHarnessBinding(
  deps: { store: Store; infer: InferProjectDeps },
  input: { client: HarnessClientId; folder?: string; projectId?: string },
  config: ResolvedHarnessToolsConfig,
): Promise<HarnessBinding> {
  if (input.projectId) {
    const project = await deps.store.getProject(input.projectId);
    if (!project) {
      throw new HarnessBindingError(
        `project ${input.projectId} was not found`,
        404,
        'project_not_found',
      );
    }
    return {
      project: {
        id: project.id,
        name: project.name,
        ...(project.workingDir ? { workingDir: project.workingDir } : {}),
        readOnly: !projectManagedWorkspaceWritable(project),
        created: false,
      },
      ...(input.folder ? { folder: input.folder } : {}),
    };
  }
  if (!input.folder) return { project: null, unboundReason: 'no-folder' };
  // Folder inference accepts a folder an app is about to create; a harness
  // reports where it already is, so a missing folder is a mistake, not a
  // project to make.
  const isDir = await stat(input.folder)
    .then((s) => s.isDirectory())
    .catch(() => false);
  if (!isDir) {
    throw new HarnessBindingError(`${input.folder} is not a folder`, 400, 'invalid_folder');
  }

  try {
    const result = await inferProjectForPath(
      deps.infer,
      {
        path: input.folder,
        kind: 'folder',
        create: config.newFolders === 'add',
        source: input.client,
        mode: 'solo',
      },
      { containing: true, adoptOrphan: false, lead: 'none' },
    );
    if (!result.project) {
      return { project: null, unboundReason: 'not-in-gezel', folder: input.folder };
    }
    return {
      project: {
        id: result.project.id,
        name: result.project.name,
        ...(result.project.workingDir ? { workingDir: result.project.workingDir } : {}),
        readOnly: result.readOnly,
        created: result.created,
      },
      folder: input.folder,
    };
  } catch (err) {
    if (err instanceof InferProjectError) {
      if (err.code === 'forbidden_root') {
        return { project: null, unboundReason: 'forbidden-root', folder: input.folder };
      }
      throw new HarnessBindingError(err.message, 400, 'invalid_folder');
    }
    throw err;
  }
}
