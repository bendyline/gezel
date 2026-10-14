import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger, nowIso } from '@bendyline/gezel';
import { FACE_WIPED_AT_META_KEY, faceMergeThreshold } from './face/constants.js';
import { type SqliteDriver, blobToFloat32, openIndexDatabase } from './sqlite-driver.js';

/**
 * Copies of a project's content index that gezel set aside instead of
 * deleting, in the project's own index folder next to the live `index.db`:
 *
 * - `index.db.superseded-<stamp>`: the copy that held less when the index
 *   move found two (`index-placement.ts`), with any `-wal`/`-shm` beside it.
 * - `index.db.corrupt-<ms>` (and `index.db-wal.corrupt-<ms>`, …): a database
 *   that could not be read, quarantined by the driver or by the move.
 * - `index.db.orphaned-<stamp>-wal`: a `-wal` found without its database.
 *
 * They can hold gigabytes and a person's faces and names, so they are kept
 * for a bounded time and every face-data erasure reaches them too.
 */

const log = createLogger('index');

/** How long a set-aside copy is kept before it is removed. */
export const PRESERVED_INDEX_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const STAMP = String.raw`(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)`;
const SUPERSEDED = new RegExp(`^index\\.db\\.superseded-${STAMP}(?:-\\d+)?$`);
const SUPERSEDED_SIDECAR = new RegExp(`^index\\.db\\.superseded-${STAMP}(?:-\\d+)?-(?:wal|shm)$`);
const CORRUPT = /^index\.db(?:-wal|-shm)?\.corrupt-(\d+)$/;
const ORPHANED = new RegExp(`^index\\.db\\.orphaned-${STAMP}-wal$`);

/** A stamp safe in a file name on every platform; {@link stampTime} reads it back. */
export function fileStamp(at = new Date()): string {
  return at.toISOString().replace(/[:.]/g, '-');
}

function stampTime(stamp: string): number {
  const m = stamp.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/);
  return m ? Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`) : Number.NaN;
}

interface SetAside {
  name: string;
  kind: 'superseded' | 'superseded-sidecar' | 'corrupt' | 'orphaned';
  at: number;
}

async function setAsideFiles(indexDir: string): Promise<SetAside[]> {
  const names = await readdir(indexDir).catch(() => [] as string[]);
  const out: SetAside[] = [];
  for (const name of names) {
    let m = name.match(SUPERSEDED);
    if (m) {
      out.push({ name, kind: 'superseded', at: stampTime(m[1]!) });
      continue;
    }
    m = name.match(SUPERSEDED_SIDECAR);
    if (m) {
      out.push({ name, kind: 'superseded-sidecar', at: stampTime(m[1]!) });
      continue;
    }
    m = name.match(CORRUPT);
    if (m) {
      out.push({ name, kind: 'corrupt', at: Number(m[1]) });
      continue;
    }
    m = name.match(ORPHANED);
    if (m) out.push({ name, kind: 'orphaned', at: stampTime(m[1]!) });
  }
  return out;
}

/** The superseded copies of a project's index, newest first. */
export async function supersededIndexCopies(indexDir: string): Promise<string[]> {
  return (await setAsideFiles(indexDir))
    .filter((f) => f.kind === 'superseded')
    .sort((a, b) => b.at - a.at)
    .map((f) => join(indexDir, f.name));
}

async function removeCopy(path: string): Promise<void> {
  for (const file of [path, `${path}-wal`, `${path}-shm`]) await rm(file, { force: true });
}

/**
 * Keep only the newest superseded copy, and nothing set aside longer than
 * {@link PRESERVED_INDEX_RETENTION_MS}. Matches set-aside names only, so the
 * live `index.db` and its sidecars are never touched. Returns what it removed.
 */
export async function prunePreservedIndexCopies(
  indexDir: string,
  now = Date.now(),
): Promise<string[]> {
  const files = await setAsideFiles(indexDir);
  const expired = (at: number) => !Number.isFinite(at) || now - at >= PRESERVED_INDEX_RETENTION_MS;
  const removed: string[] = [];
  const superseded = files.filter((f) => f.kind === 'superseded').sort((a, b) => b.at - a.at);
  const kept = superseded[0] && !expired(superseded[0].at) ? superseded[0].name : null;
  for (const copy of superseded) {
    if (copy.name === kept) continue;
    await removeCopy(join(indexDir, copy.name));
    removed.push(copy.name);
  }
  for (const file of files) {
    if (file.kind === 'superseded') continue;
    if (file.kind === 'superseded-sidecar') {
      const owner = file.name.slice(0, -'-wal'.length);
      // Kept with its copy, or already removed with it.
      if (superseded.some((c) => c.name === owner)) continue;
    } else if (!expired(file.at)) {
      continue;
    }
    await rm(join(indexDir, file.name), { force: true });
    removed.push(file.name);
  }
  return removed;
}

/** Erasures a person made, as one index records them. */
export interface FaceErasures {
  /** The latest wipe of all face data (ISO), if any. */
  wipedAt?: string;
  /** People forgotten since: their cluster ids, and centroids to find them in another copy. */
  forgotten: Array<{ id: string; centroid: Float32Array | null }>;
}

function tableNames(db: SqliteDriver): Set<string> {
  return new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all<{ name: string }>()
      .map((r) => r.name),
  );
}

export function readFaceErasures(db: SqliteDriver): FaceErasures {
  const tables = tableNames(db);
  const wipedAt = tables.has('meta')
    ? db
        .prepare('SELECT value FROM meta WHERE key = ?')
        .get<{ value: string }>(FACE_WIPED_AT_META_KEY)?.value
    : undefined;
  const forgotten = tables.has('face_clusters')
    ? db
        .prepare("SELECT id, centroid FROM face_clusters WHERE state = 'forgotten'")
        .all<{ id: string; centroid: Uint8Array | null }>()
        .map((r) => ({ id: r.id, centroid: r.centroid ? blobToFloat32(r.centroid) : null }))
    : [];
  return { ...(wipedAt ? { wipedAt } : {}), forgotten };
}

function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return -1;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

function deletePeople(db: SqliteDriver, tables: Set<string>, canonical?: string): void {
  if (!tables.has('entities')) return;
  const where = canonical === undefined ? "kind = 'person'" : "kind = 'person' AND canonical = ?";
  const args = canonical === undefined ? [] : [canonical];
  if (tables.has('entity_mentions')) {
    db.prepare(
      `DELETE FROM entity_mentions WHERE entity_id IN (SELECT id FROM entities WHERE ${where})`,
    ).run(...args);
  }
  db.prepare(`DELETE FROM entities WHERE ${where}`).run(...args);
}

/**
 * Bring another copy of an index in line with erasures recorded elsewhere. A
 * wipe newer than the copy's own deletes all of its face data; a forgotten
 * person is matched by cluster id, or by a centroid as close as the merge pass
 * requires, since copies that grew apart give the same person different ids.
 * Returns whether anything changed.
 */
export function applyFaceErasures(db: SqliteDriver, erasures: FaceErasures): boolean {
  const tables = tableNames(db);
  let changed = false;
  db.transaction(() => {
    if (erasures.wipedAt) {
      const own = tables.has('meta')
        ? db
            .prepare('SELECT value FROM meta WHERE key = ?')
            .get<{ value: string }>(FACE_WIPED_AT_META_KEY)?.value
        : undefined;
      if (!own || own < erasures.wipedAt) {
        for (const table of ['face_vectors', 'face_clusters', 'face_state']) {
          if (tables.has(table)) db.exec(`DELETE FROM ${table}`);
        }
        deletePeople(db, tables);
        db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
        db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
          FACE_WIPED_AT_META_KEY,
          erasures.wipedAt,
        );
        changed = true;
      }
    }
    if (erasures.forgotten.length === 0 || !tables.has('face_clusters')) return;
    const threshold = faceMergeThreshold();
    const clusters = db
      .prepare("SELECT id, centroid FROM face_clusters WHERE state IS NULL OR state <> 'forgotten'")
      .all<{ id: string; centroid: Uint8Array | null }>();
    const forget = db.prepare(
      "UPDATE face_clusters SET state = 'forgotten', updated_at = ? WHERE id = ?",
    );
    for (const cluster of clusters) {
      const centroid = cluster.centroid ? blobToFloat32(cluster.centroid) : null;
      const match = erasures.forgotten.some(
        (f) =>
          f.id === cluster.id ||
          (f.centroid !== null && centroid !== null && cosine(f.centroid, centroid) >= threshold),
      );
      if (!match) continue;
      forget.run(nowIso(), cluster.id);
      deletePeople(db, tables, cluster.id);
      changed = true;
    }
  });
  return changed;
}

/**
 * Apply a wipe or a forgotten person to every set-aside copy of one project's
 * index. A copy that cannot be opened cannot be erased row by row, so a wipe
 * removes it; corrupt and orphaned files go on a wipe for the same reason.
 */
export async function erasePreservedFaceData(
  indexDir: string,
  erasures: FaceErasures,
): Promise<void> {
  for (const copy of await supersededIndexCopies(indexDir)) {
    let db: SqliteDriver | null = null;
    try {
      db = await openIndexDatabase(copy, { quarantineCorrupt: false });
      if (db) applyFaceErasures(db, erasures);
    } catch (err) {
      if (!erasures.wipedAt) continue;
      log.warn(`could not erase face data in ${copy}, removing it instead: ${String(err)}`);
      db?.close();
      db = null;
      await removeCopy(copy);
    } finally {
      db?.close();
    }
  }
  if (!erasures.wipedAt) return;
  for (const file of await setAsideFiles(indexDir)) {
    if (file.kind === 'corrupt' || file.kind === 'orphaned') {
      await rm(join(indexDir, file.name), { force: true });
    }
  }
}
