import { existsSync } from 'node:fs';
import { copyFile, mkdir, rename, rm, rmdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createLogger, isSharedLibraryProject } from '@bendyline/gezel';
import {
  projectContentIndexDbFile,
  projectLocalIndexDbFile,
  projectLocalIndexDir,
  projectLocalRoot,
  projectStorageScope,
} from '@bendyline/gezel/paths';
import { type SqliteDriver, openIndexDatabase } from './sqlite-driver.js';

const log = createLogger('index');

export interface IndexPlacementStore {
  listProjects(): Promise<
    Array<{ id: string; properties?: Record<string, string>; workingDir?: string }>
  >;
  projectWorkspaceDir(projectId: string): Promise<string>;
}

export type IndexPlacementOutcome =
  /** Moved into place; the folder no longer holds gezel's index. */
  | 'moved'
  /** Copied (the old file was in use elsewhere); the original is retried next boot. */
  | 'copied'
  /** A home-side index already existed; only the stale folder copy was removed. */
  | 'cleaned'
  /** The folder copy is in use elsewhere and a home-side index already exists. */
  | 'left-in-place'
  | 'failed';

export interface IndexPlacementResult {
  projectId: string;
  outcome: IndexPlacementOutcome;
}

/**
 * Move content-index databases out of people's folders. Earlier builds kept a
 * project's index at `<workspace>/.gezel/index/index.db`; it now always lives
 * in gezel's own per-project folder (`projectContentIndexDbFile`), so adding a
 * folder never writes into it. Moved rather than rebuilt: summaries, reviews
 * and embeddings are hours of model work.
 *
 * Runs once at boot, before the workspace indexer or enrichment opens any
 * index. The shared library already kept its index home-side; machine-shared
 * workspaces are skipped because a folder copy there may belong to another
 * account's daemon. A database another process holds is snapshotted, not
 * moved, and its original is retried at the next boot.
 */
export async function migrateWorkspaceIndexes(deps: {
  store: IndexPlacementStore;
  home: string;
}): Promise<IndexPlacementResult[]> {
  const projects = await deps.store.listProjects().catch(() => []);
  const results: IndexPlacementResult[] = [];
  for (const project of projects) {
    if (isSharedLibraryProject(project)) continue;
    if (projectStorageScope(deps.home, project.id) === 'machine-shared') continue;
    let workspaceDir: string;
    try {
      workspaceDir = await deps.store.projectWorkspaceDir(project.id);
    } catch {
      continue;
    }
    const legacy = projectLocalIndexDbFile(workspaceDir);
    if (!existsSync(legacy)) continue;
    const target = projectContentIndexDbFile(deps.home, project.id, workspaceDir);
    if (target === legacy) continue;
    const outcome = await migrateOne(legacy, target).catch((err) => {
      log.warn(`[index] could not move ${project.id}'s index out of its folder: ${String(err)}`);
      return 'failed' as const;
    });
    if (outcome === 'moved' || outcome === 'cleaned') {
      await removeEmptyIndexDirs(workspaceDir);
    }
    log.info(`[index] ${project.id}: workspace index ${outcome}`);
    results.push({ projectId: project.id, outcome });
  }
  return results;
}

async function migrateOne(legacy: string, target: string): Promise<IndexPlacementOutcome> {
  const db = await openIndexDatabase(legacy);
  if (!db) return 'failed';
  let sole = false;
  try {
    sole = takeSoleOwnership(db);
    if (existsSync(target)) {
      // A home-side index is current already (a build in between, or a
      // fallback after an unwritable folder): keep it, drop the stale copy.
      return sole ? 'cleaned' : 'left-in-place';
    }
    await mkdir(dirname(target), { recursive: true });
    if (!sole) {
      // Another process has it open: take a consistent snapshot, leave the
      // original for the next boot.
      await rm(`${target}.migrating`, { force: true });
      db.exec(`VACUUM INTO ${sqlString(`${target}.migrating`)}`);
      await rename(`${target}.migrating`, target);
      return 'copied';
    }
  } finally {
    db.close();
  }

  // Out of WAL with no other connection: the main file is the whole database.
  // The index turns WAL back on when it opens the moved file.
  try {
    await rename(legacy, target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    // Another volume (an external drive): copy, publish, then remove.
    await copyFile(legacy, `${target}.migrating`);
    await rename(`${target}.migrating`, target);
  }
  return 'moved';
}

/**
 * Whether this is the only connection to the file. Leaving WAL needs an
 * exclusive lock, and every open WAL connection holds a shared one, so the
 * switch succeeds only when no other process has the index open; it also
 * folds the WAL into the main file. `BEGIN EXCLUSIVE` alone would not do:
 * in WAL mode it shuts out writers but not readers.
 */
function takeSoleOwnership(db: SqliteDriver): boolean {
  try {
    db.exec('PRAGMA busy_timeout=0;');
    const mode = db.prepare('PRAGMA journal_mode=DELETE;').get<{ journal_mode: string }>();
    if (mode?.journal_mode !== 'delete') return false;
    db.exec('BEGIN EXCLUSIVE;');
    db.exec('ROLLBACK;');
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove what earlier builds wrote under `<workspace>/.gezel/index/`, then the
 * directories themselves if nothing else is in them. Never recursive: a
 * `.gezel/` folder can also hold a person's own committed definitions.
 */
async function removeEmptyIndexDirs(workspaceDir: string): Promise<void> {
  const indexDir = projectLocalIndexDir(workspaceDir);
  for (const name of ['index.db', 'index.db-wal', 'index.db-shm', '.gitignore']) {
    await rm(join(indexDir, name), { force: true }).catch(() => {});
  }
  await rmdir(indexDir).catch(() => {});
  await rmdir(projectLocalRoot(workspaceDir)).catch(() => {});
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
