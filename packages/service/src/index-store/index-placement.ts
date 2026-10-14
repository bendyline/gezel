import { existsSync } from 'node:fs';
import { copyFile, mkdir, open, rename, rm, rmdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createLogger, isSharedLibraryProject } from '@bendyline/gezel';
import {
  fallbackProjectIndexDir,
  projectContentIndexDbFile,
  projectLocalIndexDbFile,
  projectLocalIndexDir,
  projectLocalRoot,
  projectStorageScope,
} from '@bendyline/gezel/paths';
import {
  applyFaceErasures,
  fileStamp,
  prunePreservedIndexCopies,
  readFaceErasures,
} from './preserved-indexes.js';
import { type SqliteDriver, isCorruptDatabaseError, openIndexDatabase } from './sqlite-driver.js';

const log = createLogger('index');

/**
 * Meta key on a home-side index made from a folder copy that stayed in the
 * folder (a snapshot, or a copy whose source could not be removed): what that
 * copy held. While the folder copy still matches, it has nothing the
 * home-side index lacks, whatever the work counts say.
 */
const SOURCE_FINGERPRINT_META_KEY = 'legacy_source_fingerprint';

export interface IndexPlacementStore {
  listProjects(): Promise<
    Array<{ id: string; properties?: Record<string, string>; workingDir?: string }>
  >;
  projectWorkspaceDir(projectId: string): Promise<string>;
}

export type IndexPlacementOutcome =
  /** Moved into place; the folder no longer holds gezel's index. */
  | 'moved'
  /** Snapshotted (the folder copy was in use elsewhere); the original is retried next boot. */
  | 'copied'
  /** Both existed and the home-side index held more: it stays live, the folder copy is preserved beside it. */
  | 'cleaned'
  /** Both existed and the folder copy held more: it is now live, the home-side one is preserved beside it. */
  | 'replaced'
  /** Both existed and a copy that would have to move could not; nothing changed. */
  | 'left-in-place'
  /** The folder copy could not be read; it was moved home-side as `index.db.corrupt-<ms>`. */
  | 'quarantined'
  | 'failed';

export interface IndexPlacementResult {
  projectId: string;
  outcome: IndexPlacementOutcome;
  /** Where a copy that is no longer live was kept. */
  preservedAs?: string;
}

interface Placement {
  outcome: IndexPlacementOutcome;
  preservedAs?: string;
  detail?: string;
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
 *
 * When both copies exist, neither is deleted. A home-side index can be nearly
 * empty while the folder copy is rich: older builds fell back home-side on a
 * transient lock, and any boot whose move failed or was skipped (a busy file,
 * an unmounted drive) let the index open mint an empty one. The copy holding
 * more model work stays live and the other is kept beside it, for a bounded
 * time (`preserved-indexes.ts`), each copy honouring the face-data erasures
 * the other recorded.
 */
export async function migrateWorkspaceIndexes(deps: {
  store: IndexPlacementStore;
  home: string;
}): Promise<IndexPlacementResult[]> {
  const projects = await deps.store.listProjects().catch(() => []);
  const results: IndexPlacementResult[] = [];
  for (const project of projects) {
    const result = await placeProject(deps.store, deps.home, project);
    if (result) results.push(result);
    const pruned = await prunePreservedIndexCopies(
      fallbackProjectIndexDir(deps.home, project.id),
    ).catch(() => []);
    if (pruned.length > 0) {
      log.info(
        `${project.id}: removed set-aside index copies past retention: ${pruned.join(', ')}`,
      );
    }
  }
  return results;
}

async function placeProject(
  store: IndexPlacementStore,
  home: string,
  project: { id: string; properties?: Record<string, string> },
): Promise<IndexPlacementResult | null> {
  if (isSharedLibraryProject(project)) return null;
  if (projectStorageScope(home, project.id) === 'machine-shared') return null;
  let workspaceDir: string;
  try {
    workspaceDir = await store.projectWorkspaceDir(project.id);
  } catch {
    return null;
  }
  const legacy = projectLocalIndexDbFile(workspaceDir);
  if (!existsSync(legacy)) return null;
  const target = projectContentIndexDbFile(home, project.id, workspaceDir);
  if (target === legacy) return null;
  const placed = await migrateOne(legacy, target).catch(
    (err): Placement => ({
      outcome: 'failed',
      detail: `could not move it out of the folder, which keeps it: ${String(err)}`,
    }),
  );
  if (['moved', 'cleaned', 'replaced', 'quarantined'].includes(placed.outcome)) {
    await removeEmptyIndexDirs(workspaceDir);
  }
  const line = `${project.id}: workspace index ${placed.outcome}${placed.detail ? ` — ${placed.detail}` : ''}`;
  if (placed.outcome === 'failed') log.warn(line);
  else log.info(line);
  return {
    projectId: project.id,
    outcome: placed.outcome,
    ...(placed.preservedAs ? { preservedAs: placed.preservedAs } : {}),
  };
}

async function migrateOne(legacy: string, target: string): Promise<Placement> {
  await mkdir(dirname(target), { recursive: true });
  const staging = `${target}.migrating`;
  await rm(staging, { force: true });
  let legacyDb: SqliteDriver | null;
  try {
    legacyDb = await openIndexDatabase(legacy, { quarantineCorrupt: false });
  } catch (err) {
    if (!isCorruptDatabaseError(err)) throw err;
    return quarantineLegacy(legacy, target, staging, err);
  }
  if (!legacyDb) return { outcome: 'failed', detail: 'sqlite is unavailable' };
  const closeLegacy = closeOnce(legacyDb);
  try {
    return existsSync(target)
      ? await reconcile(legacy, legacyDb, closeLegacy, target, staging)
      : await adopt(legacy, legacyDb, closeLegacy, target, staging);
  } finally {
    closeLegacy();
  }
}

/**
 * A folder copy SQLite cannot read. Left to the driver, it would be renamed
 * aside and a fresh database started in its place, both inside the person's
 * folder; it moves home-side instead, with its sidecars, under the driver's
 * quarantine names.
 */
async function quarantineLegacy(
  legacy: string,
  target: string,
  staging: string,
  reason: unknown,
): Promise<Placement> {
  const suffix = `.corrupt-${Date.now()}`;
  const dir = dirname(target);
  const preservedAs = join(dir, `index.db${suffix}`);
  for (const sidecar of ['', '-wal', '-shm']) {
    const from = `${legacy}${sidecar}`;
    if (!existsSync(from)) continue;
    const to = join(dir, `index.db${sidecar}${suffix}`);
    if (!(await moveFile(from, to, staging))) {
      await rm(to, { force: true });
      return {
        outcome: 'failed',
        detail: `the folder copy cannot be read (${String(reason)}) and could not be removed from the folder; retried next boot`,
      };
    }
  }
  return {
    outcome: 'quarantined',
    preservedAs,
    detail: `the folder copy cannot be read (${String(reason)}); it is kept at ${preservedAs}`,
  };
}

/** No home-side index yet: the folder copy becomes it. */
async function adopt(
  legacy: string,
  db: SqliteDriver,
  closeLegacy: () => void,
  target: string,
  staging: string,
): Promise<Placement> {
  if (!takeSoleOwnership(db)) {
    await snapshotInto(db, target, staging);
    return {
      outcome: 'copied',
      detail:
        'the folder copy is in use elsewhere; a snapshot of it is live and the original is retried next boot',
    };
  }
  const print = contentFingerprint(db);
  closeLegacy();
  await setAsideOrphanSidecars(target);
  // Out of WAL with no other connection: the main file is the whole database.
  // The index turns WAL back on when it opens the moved file.
  if (!(await moveFile(legacy, target, staging))) {
    await recordSource(target, print);
    return {
      outcome: 'copied',
      detail: 'copied across volumes, but the folder copy could not be removed; retried next boot',
    };
  }
  return { outcome: 'moved' };
}

/** Both copies exist: keep the richer one live and preserve the other. */
async function reconcile(
  legacy: string,
  legacyDb: SqliteDriver,
  closeLegacy: () => void,
  target: string,
  staging: string,
): Promise<Placement> {
  const legacySole = takeSoleOwnership(legacyDb);
  const legacyWork = measureWork(legacyDb);
  const legacyPrint = contentFingerprint(legacyDb);
  const homeDb = await openIndexDatabase(target).catch(() => null);
  const closeHome = homeDb ? closeOnce(homeDb) : () => {};
  let homeSole = false;
  let winner: 'home' | 'folder';
  let why: string;
  try {
    const homeWork = homeDb ? measureWork(homeDb) : null;
    const madeFromThisCopy =
      homeDb !== null && legacyPrint !== null && recordedSource(homeDb) === legacyPrint;
    ({ winner, why } = madeFromThisCopy
      ? {
          winner: 'home',
          why: 'the home-side index was made from this folder copy, which has not changed since',
        }
      : await richerCopy(target, homeWork, legacy, legacyWork));
    if (legacySole && winner === 'folder' && homeDb) homeSole = takeSoleOwnership(homeDb);
  } finally {
    closeHome();
  }

  // A folder copy held elsewhere never replaces a home-side index. Its
  // snapshot would be frozen while the live index keeps changing, and its
  // counts can rise above a live index whose own fall (an embedder reset, a
  // prune): each boot would revert that boot's work and set aside one more copy.
  if (!legacySole) {
    return {
      outcome: 'left-in-place',
      detail:
        winner === 'home'
          ? `the home-side copy stays live (${why}); the folder copy is in use elsewhere and is retried next boot`
          : `the folder copy holds more (${why}) but is in use elsewhere; the home-side copy stays live and both are retried next boot`,
    };
  }
  closeLegacy();

  if (winner === 'home') {
    const preservedAs = supersededPath(target);
    if (!(await moveFile(legacy, preservedAs, staging))) {
      await rm(preservedAs, { force: true });
      return {
        outcome: 'left-in-place',
        detail: `the home-side copy stays live (${why}); the folder copy was copied but could not be removed, so the copy was dropped and both are retried next boot`,
      };
    }
    await reconcileErasures(target, preservedAs);
    return {
      outcome: 'cleaned',
      preservedAs,
      detail: `the home-side copy stays live (${why}); the folder copy is preserved at ${preservedAs}`,
    };
  }

  if (!homeSole) {
    return {
      outcome: 'left-in-place',
      detail: `the folder copy holds more (${why}) but the home-side index is in use; both are kept and retried next boot`,
    };
  }
  const preservedAs = supersededPath(target);
  let sourceRemoved: boolean;
  try {
    await renameWithSidecars(target, preservedAs);
    sourceRemoved = await moveFile(legacy, target, staging);
  } catch (err) {
    await renameWithSidecars(preservedAs, target).catch(() => {});
    throw err;
  }
  if (!sourceRemoved) await recordSource(target, legacyPrint);
  await reconcileErasures(target, preservedAs);
  if (!sourceRemoved) {
    return {
      outcome: 'copied',
      preservedAs,
      detail: `the folder copy is now live (${why}), copied across volumes; it could not be removed from the folder and is retried next boot; the previous home-side copy is preserved at ${preservedAs}`,
    };
  }
  return {
    outcome: 'replaced',
    preservedAs,
    detail: `the folder copy is now live (${why}); the previous home-side copy is preserved at ${preservedAs}`,
  };
}

/**
 * Each copy honours the face-data erasures the other recorded: a wipe or a
 * forgotten person made on the home-side index must not return with the
 * folder copy, and the other way round. A preserved copy that cannot be
 * erased after a wipe is removed.
 */
async function reconcileErasures(live: string, preserved: string): Promise<void> {
  let liveDb: SqliteDriver | null = null;
  let preservedDb: SqliteDriver | null = null;
  try {
    liveDb = await openIndexDatabase(live, { quarantineCorrupt: false });
    if (!liveDb) return;
    const fromLive = readFaceErasures(liveDb);
    try {
      preservedDb = await openIndexDatabase(preserved, { quarantineCorrupt: false });
      if (!preservedDb) return;
      const fromPreserved = readFaceErasures(preservedDb);
      applyFaceErasures(preservedDb, fromLive);
      applyFaceErasures(liveDb, fromPreserved);
    } catch (err) {
      if (!fromLive.wipedAt) throw err;
      preservedDb?.close();
      preservedDb = null;
      for (const file of [preserved, `${preserved}-wal`, `${preserved}-shm`]) {
        await rm(file, { force: true });
      }
      log.warn(`removed ${preserved}: its face data could not be erased (${String(err)})`);
    }
  } catch (err) {
    log.warn(
      `could not reconcile face-data erasures between ${live} and ${preserved}: ${String(err)}`,
    );
  } finally {
    preservedDb?.close();
    liveDb?.close();
  }
}

/** Remember which folder copy a home-side index was made from. */
async function recordSource(target: string, print: string | null): Promise<void> {
  if (print === null) return;
  const db = await openIndexDatabase(target, { quarantineCorrupt: false }).catch(() => null);
  if (!db) return;
  try {
    db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
      SOURCE_FINGERPRINT_META_KEY,
      print,
    );
  } catch {
    /* without the record the next boot compares work counts, as for any copy */
  } finally {
    db.close();
  }
}

function recordedSource(db: SqliteDriver): string | null {
  try {
    return (
      db
        .prepare('SELECT value FROM meta WHERE key = ?')
        .get<{ value: string }>(SOURCE_FINGERPRINT_META_KEY)?.value ?? null
    );
  } catch {
    return null;
  }
}

/**
 * Tables holding what a model produced or a person decided. Everything else
 * in the index (files, chunks, symbols, imports) the static pass rebuilds in
 * minutes; these are hours of model work, people's names and "forget this
 * person" tombstones.
 */
const WORK_TABLES: ReadonlyArray<readonly [table: string, where?: string]> = [
  ['summaries'],
  ['file_reviews'],
  ['symbol_summaries'],
  ['area_summaries'],
  ['enrichments', 'embedded_at IS NOT NULL'],
  ['embed_state', 'embedded_at IS NOT NULL'],
  ['shadow_state', "state = 'ok'"],
  ['media_vectors'],
  ['face_vectors'],
  ['face_clusters'],
  ['entities', "kind = 'person'"],
];

interface IndexWork {
  /** Rows of model output and person decisions. */
  work: number;
  /** Indexed files: the tie-break, so a populated static index beats an empty one. */
  files: number;
}

function tableCounter(db: SqliteDriver): (table: string, where?: string) => number | null {
  const tables = new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all<{ name: string }>()
      .map((r) => r.name),
  );
  return (table, where) =>
    tables.has(table)
      ? Number(
          db
            .prepare(`SELECT count(*) AS n FROM ${table}${where ? ` WHERE ${where}` : ''}`)
            .get<{ n: number | bigint }>()?.n ?? 0,
        )
      : null;
}

function measureWork(db: SqliteDriver): IndexWork | null {
  try {
    const count = tableCounter(db);
    let work = 0;
    for (const [table, where] of WORK_TABLES) work += count(table, where) ?? 0;
    return { work, files: count('files') ?? 0 };
  } catch {
    return null;
  }
}

/**
 * What a copy holds, closely enough to tell whether it changed since a copy
 * of it was made: every counted table, the static index, and the latest file
 * indexing time. Null when the copy cannot be read.
 */
function contentFingerprint(db: SqliteDriver): string | null {
  try {
    const count = tableCounter(db);
    const parts = [...WORK_TABLES, ['files'], ['chunks'], ['symbols']].map(
      ([table, where]) => `${table}=${count(table!, where) ?? '-'}`,
    );
    let newest = '-';
    try {
      newest =
        db.prepare('SELECT max(indexed_at) AS at FROM files').get<{ at: string | null }>()?.at ??
        '-';
    } catch {
      /* an index without the column */
    }
    parts.push(`indexed=${newest}`);
    return parts.join(';');
  } catch {
    return null;
  }
}

/**
 * Which copy holds more. A tie keeps the home-side copy, which is already in
 * place. When either copy cannot be read, file size decides.
 */
async function richerCopy(
  home: string,
  homeWork: IndexWork | null,
  folder: string,
  folderWork: IndexWork | null,
): Promise<{ winner: 'home' | 'folder'; why: string }> {
  if (homeWork && folderWork) {
    if (folderWork.work !== homeWork.work) {
      return {
        winner: folderWork.work > homeWork.work ? 'folder' : 'home',
        why: `${folderWork.work} rows of model work in the folder, ${homeWork.work} home-side`,
      };
    }
    return {
      winner: folderWork.files > homeWork.files ? 'folder' : 'home',
      why: `${homeWork.work} rows of model work in each; ${folderWork.files} indexed files in the folder, ${homeWork.files} home-side`,
    };
  }
  const [homeBytes, folderBytes] = await Promise.all([databaseBytes(home), databaseBytes(folder)]);
  return {
    winner: folderBytes > homeBytes ? 'folder' : 'home',
    why: `unreadable, compared by size: ${folderBytes} bytes in the folder, ${homeBytes} home-side`,
  };
}

async function databaseBytes(path: string): Promise<number> {
  let total = 0;
  for (const file of [path, `${path}-wal`]) {
    total += await stat(file).then(
      (s) => s.size,
      () => 0,
    );
  }
  return total;
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
 * A consistent copy of a database another process holds open. SQLite does not
 * sync a `VACUUM INTO` output, so it is synced before it takes the final name.
 */
async function snapshotInto(db: SqliteDriver, target: string, staging: string): Promise<void> {
  await rm(staging, { force: true });
  db.exec(`VACUUM INTO ${sqlString(staging)}`);
  const snapshot = await openIndexDatabase(staging, { quarantineCorrupt: false });
  if (snapshot) {
    const print = contentFingerprint(snapshot);
    snapshot.close();
    await recordSource(staging, print);
  }
  await syncFile(staging);
  await setAsideOrphanSidecars(target);
  await rename(staging, target);
  await syncDir(dirname(target));
}

/**
 * Move a closed, sole-owned database file. Across volumes it is copied, made
 * durable, published under its final name, and only then removed from where it
 * was, so a crash at any point leaves the original in place. False when the
 * copy landed but the original could not be removed (Windows reports EBUSY
 * while a scanner or sync client holds the file); the caller decides whether
 * the copy stays.
 */
async function moveFile(from: string, to: string, staging: string): Promise<boolean> {
  try {
    await rename(from, to);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
  }
  await rm(staging, { force: true });
  await copyFile(from, staging);
  await syncFile(staging);
  await rename(staging, to);
  await syncDir(dirname(to));
  try {
    await rm(from);
    return true;
  } catch (err) {
    log.warn(`copied ${from} to ${to} but could not remove the original: ${String(err)}`);
    return false;
  }
}

/** Same-directory rename of a home-side database with whatever sidecars it has. */
async function renameWithSidecars(from: string, to: string): Promise<void> {
  await rename(from, to);
  for (const suffix of ['-wal', '-shm']) {
    await rename(`${from}${suffix}`, `${to}${suffix}`).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') throw err;
    });
  }
}

/**
 * SQLite replays any `-wal` it finds beside a database, whichever database
 * wrote it. One left without its main file must not be applied to the file
 * about to take that name.
 */
async function setAsideOrphanSidecars(target: string): Promise<void> {
  if (existsSync(target)) return;
  await rename(`${target}-wal`, `${target}.orphaned-${fileStamp()}-wal`).catch(
    (err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') throw err;
    },
  );
  await rm(`${target}-shm`, { force: true });
}

function supersededPath(target: string): string {
  const base = `${target}.superseded-${fileStamp()}`;
  let candidate = base;
  for (let n = 1; existsSync(candidate); n++) candidate = `${base}-${n}`;
  return candidate;
}

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Make a rename durable. Windows cannot open a directory for sync; NTFS journals the rename. */
async function syncDir(dir: string): Promise<void> {
  try {
    const handle = await open(dir, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    /* not supported on this platform or filesystem */
  }
}

function closeOnce(db: SqliteDriver): () => void {
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    db.close();
  };
}

/**
 * Remove what earlier builds wrote under `<workspace>/.gezel/index/`, then the
 * directories themselves if nothing else is in them. Never recursive: a
 * `.gezel/` folder can also hold a person's own committed definitions. The
 * database itself is removed only by the move that preserved it, and nothing
 * else is while it is still there: its `-wal` can hold a live database's pages.
 */
async function removeEmptyIndexDirs(workspaceDir: string): Promise<void> {
  const indexDir = projectLocalIndexDir(workspaceDir);
  if (existsSync(join(indexDir, 'index.db'))) return;
  for (const name of ['index.db-wal', 'index.db-shm', '.gitignore']) {
    await rm(join(indexDir, name), { force: true }).catch(() => {});
  }
  await rmdir(indexDir).catch(() => {});
  await rmdir(projectLocalRoot(workspaceDir)).catch(() => {});
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
