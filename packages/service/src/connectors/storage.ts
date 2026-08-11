/**
 * Connector corpus storage resolution and legacy migration.
 *
 * Corpora used to live under the resolved project workspace. They now belong
 * in the project's managed artifacts tree, where external data cannot dirty a
 * user's repo. Before the first post-upgrade sync, move an existing corpus to
 * the new root so its advanced cursor does not strand already-fetched records.
 */

import { cp, mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createLogger } from '@bendyline/gezel';
import { resolveInside } from '../fs/safe-paths.js';
import type { Store } from '../fs/store.js';

const log = createLogger('connectors');

async function isDirectory(path: string): Promise<boolean> {
  return stat(path)
    .then((info) => info.isDirectory())
    .catch(() => false);
}

/**
 * Resolve the artifacts root used for connector writes and migrate a corpus
 * from its old workspace location when necessary. The common same-volume case
 * is an atomic rename. External workspaces can cross devices, so that case is
 * copied into a sibling staging directory, atomically published, then removed
 * from the workspace only after the complete copy is visible.
 */
export async function connectorCorpusStorage(
  store: Store,
  projectId: string,
  corpusDir: string,
): Promise<{ storageDir: string; quarantineWorkspaceDir: string; migrated: boolean }> {
  const storageDir = store.projectArtifactsDir(projectId);
  const quarantineWorkspaceDir = await store.projectWorkspaceDir(projectId);
  await mkdir(storageDir, { recursive: true });
  const legacy = await resolveInside(quarantineWorkspaceDir, corpusDir);
  const target = await resolveInside(storageDir, corpusDir);

  let migrated = false;
  if (legacy !== target && (await isDirectory(legacy))) {
    if (await isDirectory(target)) {
      // A target can already exist after an interrupted cross-device move or
      // because this version has synced it. Never merge two mutable corpora or
      // delete either side automatically; all future writes still use target.
      log.warn(
        `connector corpus exists in workspace and artifacts (${projectId}/${corpusDir}); using artifacts and leaving the legacy copy untouched`,
      );
    } else {
      await mkdir(dirname(target), { recursive: true });
      try {
        await rename(legacy, target);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
        const staging = `${target}.migrating`;
        await rm(staging, { recursive: true, force: true });
        await cp(legacy, staging, { recursive: true, errorOnExist: true, force: false });
        await rename(staging, target);
        await rm(legacy, { recursive: true, force: true });
      }
      migrated = true;
      log.info(`migrated connector corpus to artifacts (${projectId}/${corpusDir})`);
    }
  }

  return { storageDir, quarantineWorkspaceDir, migrated };
}
