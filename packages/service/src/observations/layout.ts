/**
 * On-disk layout of an observation corpus, and the bookkeeping beside it.
 *
 * ```
 * artifacts/data/<corpus>/
 * ├── _meta.json                     connector binding provenance (existing)
 * ├── _actions/                      the mutable surface (existing)
 * └── tables/                        <- this module
 *     └── <table>/
 *         ├── manifest.json          the semantic layer
 *         ├── state.json             part counter + compaction watermarks
 *         ├── dt=2026-08-28/
 *         │   ├── part-000123.parquet   sealed, immutable
 *         │   ├── sealed-000124.ndjson  awaiting compaction
 *         │   └── open-000125.ndjson    this pass's landing buffer
 *         └── rollups/<name>/dt=…/part-000.parquet
 * ```
 *
 * `tables/` is deliberately NOT underscore-prefixed. Inside a corpus the
 * underscore marks the *mutable* surface, and `isProtectedConnectorCorpusPath`
 * already denies gezel writes to everything under `data/` that lacks one. A
 * bare name therefore inherits the existing read-only guard instead of
 * requiring a second, parallel one that could drift from it.
 *
 * Partitions are Hive-style directory levels (`dt=<value>`) because that is
 * what makes a filter on the partition column *prune* whole directories
 * rather than scan them. Most of the reason this shape scales is that a
 * question about last week never opens last year's files.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { type ObservationTableManifest, ObservationTableManifestSchema } from '@bendyline/gezel';
import {
  CONNECTOR_ROLLUPS_DIR_NAME,
  CONNECTOR_TABLES_DIR_NAME,
  OBSERVATION_TABLE_MANIFEST_FILE,
  OBSERVATION_TABLE_STATE_FILE,
} from '@bendyline/gezel/paths';
import { writeFileAtomic } from '../fs/atomic.js';
import { resolveInside } from '../fs/safe-paths.js';

/** Partition directory value used when a table has no partition column. */
export const UNPARTITIONED = 'all';

/** Hive-style partition directory name. */
export function partitionDirName(partitionColumn: string, value: string): string {
  return `${partitionColumn}=${value}`;
}

/** Parse a Hive-style partition directory back to its value, or null. */
export function partitionValueFromDir(dirName: string): { column: string; value: string } | null {
  const eq = dirName.indexOf('=');
  if (eq <= 0 || eq === dirName.length - 1) return null;
  return { column: dirName.slice(0, eq), value: dirName.slice(eq + 1) };
}

/** Artifact-relative path of a corpus's tables root. */
export function tablesRelDir(corpusDir: string): string {
  return `${corpusDir}/${CONNECTOR_TABLES_DIR_NAME}`;
}

/** Artifact-relative path of one table's directory. */
export function tableRelDir(corpusDir: string, table: string): string {
  return `${tablesRelDir(corpusDir)}/${table}`;
}

/** Artifact-relative path of one table's rollups root. */
export function rollupsRelDir(corpusDir: string, table: string): string {
  return `${tableRelDir(corpusDir, table)}/${CONNECTOR_ROLLUPS_DIR_NAME}`;
}

/**
 * Per-table bookkeeping. Small, rewritten atomically, and regenerable in
 * principle — but kept on disk because deriving `nextPart` by scanning
 * directories would reuse an ordinal after a retention sweep deleted the
 * partition that held the highest one.
 */
export interface ObservationTableState {
  schemaVersion: 1;
  /** Monotonic across the whole table, never reset. */
  nextPart: number;
  /** Rows the writer has committed, for stats and truncation checks. */
  totalRows: number;
  lastWriteAt?: string;
  lastCompactionAt?: string;
  /** Per-rollup ISO timestamp of the last successful materialization. */
  rollupWatermarks?: Record<string, string>;
  /**
   * Night-shift window key this table was last maintained in. Per-table
   * rather than per-project so an interrupted window resumes where it
   * stopped instead of re-running the tables it already finished.
   */
  lastNightlyWindow?: string;
  /** Raw partitions removed by retention, for the audit trail. */
  prunedPartitions?: number;
  /** Set when a compaction refused to publish; cleared on the next success. */
  lastError?: string;
}

export function emptyTableState(): ObservationTableState {
  return { schemaVersion: 1, nextPart: 0, totalRows: 0 };
}

export async function readTableState(
  storageDir: string,
  corpusDir: string,
  table: string,
): Promise<ObservationTableState> {
  const path = await resolveInside(
    storageDir,
    `${tableRelDir(corpusDir, table)}/${OBSERVATION_TABLE_STATE_FILE}`,
  );
  if (!existsSync(path)) return emptyTableState();
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<ObservationTableState>;
    if (parsed.schemaVersion !== 1) return emptyTableState();
    return {
      schemaVersion: 1,
      nextPart: typeof parsed.nextPart === 'number' ? parsed.nextPart : 0,
      totalRows: typeof parsed.totalRows === 'number' ? parsed.totalRows : 0,
      ...(parsed.lastWriteAt ? { lastWriteAt: parsed.lastWriteAt } : {}),
      ...(parsed.lastCompactionAt ? { lastCompactionAt: parsed.lastCompactionAt } : {}),
      ...(parsed.rollupWatermarks ? { rollupWatermarks: parsed.rollupWatermarks } : {}),
      ...(parsed.lastNightlyWindow ? { lastNightlyWindow: parsed.lastNightlyWindow } : {}),
      ...(typeof parsed.prunedPartitions === 'number'
        ? { prunedPartitions: parsed.prunedPartitions }
        : {}),
      ...(parsed.lastError ? { lastError: parsed.lastError } : {}),
    };
  } catch {
    // A corrupt state file must not strand the corpus. Restarting the counter
    // is safe: part names collide only within one partition directory, and
    // `nextPartAvoidingCollisions` re-derives past any existing file.
    return emptyTableState();
  }
}

export async function writeTableState(
  storageDir: string,
  corpusDir: string,
  table: string,
  state: ObservationTableState,
): Promise<void> {
  const path = await resolveInside(
    storageDir,
    `${tableRelDir(corpusDir, table)}/${OBSERVATION_TABLE_STATE_FILE}`,
  );
  // A table can be registered before it has rows — an empty first page still
  // establishes its schema so `list_tables` can show it — and in that case no
  // partition directory has been created yet.
  await mkdir(dirname(path), { recursive: true });
  await writeFileAtomic(path, `${JSON.stringify(state, null, 2)}\n`);
}

export async function readTableManifest(
  storageDir: string,
  corpusDir: string,
  table: string,
): Promise<ObservationTableManifest | null> {
  const path = await resolveInside(
    storageDir,
    `${tableRelDir(corpusDir, table)}/${OBSERVATION_TABLE_MANIFEST_FILE}`,
  );
  if (!existsSync(path)) return null;
  try {
    return ObservationTableManifestSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  } catch {
    // An unparseable manifest is a real problem, but it must not make the
    // corpus unreadable: the caller re-infers one from the landed rows.
    return null;
  }
}

export async function writeTableManifest(
  storageDir: string,
  corpusDir: string,
  manifest: ObservationTableManifest,
): Promise<void> {
  const path = await resolveInside(
    storageDir,
    `${tableRelDir(corpusDir, manifest.table)}/${OBSERVATION_TABLE_MANIFEST_FILE}`,
  );
  await mkdir(dirname(path), { recursive: true });
  await writeFileAtomic(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Every table slug present in a corpus, sorted. */
export async function listTables(storageDir: string, corpusDir: string): Promise<string[]> {
  const root = await resolveInside(storageDir, tablesRelDir(corpusDir));
  if (!existsSync(root)) return [];
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();
}

/** Partition directories of one table, newest-name-first. */
export async function listPartitions(
  storageDir: string,
  corpusDir: string,
  table: string,
): Promise<string[]> {
  const root = await resolveInside(storageDir, tableRelDir(corpusDir, table));
  if (!existsSync(root)) return [];
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  return entries
    .filter(
      (e) =>
        e.isDirectory() &&
        e.name !== CONNECTOR_ROLLUPS_DIR_NAME &&
        partitionValueFromDir(e.name) !== null,
    )
    .map((e) => e.name)
    .sort()
    .reverse();
}

/** Data files in one partition, split by lifecycle stage. */
export async function listPartitionFiles(
  storageDir: string,
  corpusDir: string,
  table: string,
  partitionDir: string,
): Promise<{ parquet: string[]; sealed: string[]; open: string[] }> {
  const root = await resolveInside(storageDir, `${tableRelDir(corpusDir, table)}/${partitionDir}`);
  const out = { parquet: [] as string[], sealed: [] as string[], open: [] as string[] };
  if (!existsSync(root)) return out;
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isFile()) continue;
    const full = join(root, entry.name);
    if (entry.name.endsWith('.parquet')) out.parquet.push(full);
    else if (entry.name.startsWith('sealed-') && entry.name.endsWith('.ndjson'))
      out.sealed.push(full);
    else if (entry.name.startsWith('open-') && entry.name.endsWith('.ndjson')) out.open.push(full);
  }
  out.parquet.sort();
  out.sealed.sort();
  out.open.sort();
  return out;
}

/** Zero-padded part ordinal, wide enough that lexical order is numeric order. */
export function partName(prefix: string, ordinal: number, ext: string): string {
  return `${prefix}-${String(ordinal).padStart(6, '0')}.${ext}`;
}
