/**
 * The night shift's maintenance pass over observation corpora.
 *
 * Daytime syncs land rows and stop there: compaction is minutes of CPU on a
 * large pass, the NDJSON is already queryable, and doing it inline would make
 * every sync feel slow for no user-visible gain. So three jobs wait for the
 * quiet hours:
 *
 * 1. **Compaction catch-up** — sealed NDJSON parts become Parquet.
 * 2. **Rollups** — declared pre-aggregates are materialized, so a common
 *    question hits a thousand rows instead of a billion.
 * 3. **Retention** — raw partitions past their keep-window are deleted.
 *
 * ── The ordering is a safety property, not a preference ───────────────────
 *
 * Retention runs LAST, and refuses to delete a partition unless every
 * declared rollup already covers it and no uncompacted NDJSON remains in it.
 * Deleting raw data before it has been summarized destroys the only copy —
 * this is the one operation in the whole subsystem that loses information,
 * and it is irreversible from gezel's side because the upstream window has
 * usually rolled past. A partition that fails either check is simply kept:
 * the cost of keeping data too long is disk, and the cost of the mistake in
 * the other direction is permanent.
 *
 * Retention is also opt-in per table (`retention.rawDays` absent = keep
 * everything), because deleting a user's mirrored data by omission would be
 * the wrong default.
 */

import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type NightShiftWindow,
  type ObservationRollup,
  type ObservationTableManifest,
  createLogger,
  nightShiftDayKey,
  nowIso,
  projectAllowsAmbientWork,
} from '@bendyline/gezel';
import { resolveInside } from '../fs/safe-paths.js';
import type { Store } from '../fs/store.js';
import { compactCorpus } from './compactor.js';
import { type DuckRunner, sqlLiteral } from './duck.js';
import {
  listPartitionFiles,
  listPartitions,
  partitionValueFromDir,
  readTableState,
  rollupsRelDir,
  tableRelDir,
  writeTableState,
} from './layout.js';
import { type ObservationTableRef, listProjectTables } from './query.js';
import { parserCheck } from './statement-guard.js';

const log = createLogger('observations');

/** Sealed parts compacted per project per night. Bounds one project's share. */
export const MAX_PARTS_PER_NIGHT = 200;
/** Partitions re-rolled per project per night. */
export const MAX_ROLLUP_PARTITIONS_PER_NIGHT = 400;
/** Rollup queries are I/O-bound and run off the interactive path. */
export const ROLLUP_TIMEOUT_MS = 10 * 60_000;

/** View name the rollup SQL's `{{table}}` token resolves to. */
const ROLLUP_SOURCE_VIEW = 'gezel_rollup_source';

export interface ObservationNightlyDeps {
  store: Store;
  duck: DuckRunner;
  /**
   * Converts tabular workspace files the interactive pass deferred for being
   * too large. Optional so the nightly pass still runs where no index is
   * wired — a connector-only project needs nothing from it.
   */
  drainWorkspaceTables?: (projectId: string) => Promise<{
    materialized: number;
    rows: number;
    deferred: number;
  } | null>;
  nightShiftWindow: () => NightShiftWindow;
  now?: () => Date;
  maxParts?: number;
  maxRollupPartitions?: number;
}

export interface ObservationNightlyResult {
  projectId: string;
  compactedParts: number;
  compactedRows: number;
  rollupPartitions: number;
  prunedPartitions: number;
  /** Workspace files converted this window, and the rows they yielded. */
  workspaceTables: number;
  workspaceRows: number;
  /** Work the per-night caps left behind, so truncation is never silent. */
  deferred: number;
  errors: string[];
  skipped?: 'inactive' | 'no-tables' | 'engine-unavailable' | 'already-run';
}

function emptyResult(projectId: string): ObservationNightlyResult {
  return {
    projectId,
    compactedParts: 0,
    compactedRows: 0,
    rollupPartitions: 0,
    prunedPartitions: 0,
    workspaceTables: 0,
    workspaceRows: 0,
    deferred: 0,
    errors: [],
  };
}

/** Maintain every project's observation corpora. */
export async function runObservationNightly(
  deps: ObservationNightlyDeps,
): Promise<ObservationNightlyResult[]> {
  const projects = await deps.store.listProjects().catch(() => []);
  const out: ObservationNightlyResult[] = [];
  for (const project of projects) {
    out.push(await runProjectObservationNightly(deps, project.id));
  }
  const worked = out.filter(
    (r) =>
      r.compactedParts > 0 ||
      r.rollupPartitions > 0 ||
      r.prunedPartitions > 0 ||
      r.workspaceTables > 0,
  );
  if (worked.length > 0) {
    log.info(
      `nightly maintenance: ${worked
        .map(
          (r) =>
            `${r.projectId} (${r.compactedParts} part(s), ${r.rollupPartitions} rollup partition(s), ${r.prunedPartitions} pruned, ${r.workspaceTables} file table(s))`,
        )
        .join(', ')}`,
    );
  }
  return out;
}

export async function runProjectObservationNightly(
  deps: ObservationNightlyDeps,
  projectId: string,
): Promise<ObservationNightlyResult> {
  const now = deps.now?.() ?? new Date();
  const skip = (
    reason: NonNullable<ObservationNightlyResult['skipped']>,
  ): ObservationNightlyResult => ({ ...emptyResult(projectId), skipped: reason });

  const project = await deps.store.getProject(projectId).catch(() => null);
  if (!project) return skip('inactive');
  // The same ambient-work opt-out that gates every other background job. A
  // project the user has told to stay quiet stays quiet.
  if (!projectAllowsAmbientWork(project)) return skip('inactive');
  if (!deps.duck.available()) return skip('engine-unavailable');

  // BEFORE the no-tables check, deliberately. A project whose only tabular
  // content is a deferred 2 GB CSV has no tables *yet* — checking first would
  // skip it as empty and the file would never convert, on any night.
  let workspaceTables = 0;
  let workspaceRows = 0;
  if (deps.drainWorkspaceTables) {
    const drained = await deps.drainWorkspaceTables(projectId).catch((err) => {
      log.warn(`workspace table drain failed for ${projectId}: ${String(err)}`);
      return null;
    });
    if (drained) {
      workspaceTables = drained.materialized;
      workspaceRows = drained.rows;
    }
  }

  const tables = await listProjectTables(deps.store, project);
  if (tables.length === 0) {
    // Report what the drain did even when there is nothing further to
    // maintain, so a night that converted files does not read as a no-op.
    return workspaceTables > 0
      ? { ...emptyResult(projectId), workspaceTables, workspaceRows }
      : skip('no-tables');
  }

  const windowKey = nightShiftDayKey(now, deps.nightShiftWindow());
  const pending = [] as ObservationTableRef[];
  for (const ref of tables) {
    const state = await readTableState(
      deps.store.projectArtifactsDir(projectId),
      ref.corpusDir,
      ref.table,
    );
    // Per-table rather than per-project, so an interrupted window resumes on
    // the tables it did not reach instead of redoing the ones it did.
    if (state.lastNightlyWindow !== windowKey) pending.push(ref);
  }
  if (pending.length === 0) {
    return workspaceTables > 0
      ? { ...emptyResult(projectId), workspaceTables, workspaceRows }
      : skip('already-run');
  }

  const result = emptyResult(projectId);
  result.workspaceTables = workspaceTables;
  result.workspaceRows = workspaceRows;
  const storageDir = deps.store.projectArtifactsDir(projectId);
  let partBudget = deps.maxParts ?? MAX_PARTS_PER_NIGHT;
  let rollupBudget = deps.maxRollupPartitions ?? MAX_ROLLUP_PARTITIONS_PER_NIGHT;

  for (const ref of pending) {
    if (partBudget <= 0 && rollupBudget <= 0) {
      result.deferred += 1;
      continue;
    }
    try {
      // ── 1. Compaction catch-up ──────────────────────────────────────────
      if (partBudget > 0) {
        const [compaction] = await compactCorpus({
          storageDir,
          corpusDir: ref.corpusDir,
          duck: deps.duck,
          table: ref.table,
          maxParts: partBudget,
        });
        if (compaction) {
          result.compactedParts += compaction.partsCompacted;
          result.compactedRows += compaction.rowsCompacted;
          result.errors.push(...compaction.errors);
          partBudget -= compaction.partsCompacted + compaction.partsFailed;
        }
      }

      // ── 2. Rollups ──────────────────────────────────────────────────────
      const rolled = await materializeRollups(deps, storageDir, ref, rollupBudget);
      result.rollupPartitions += rolled.partitions;
      result.deferred += rolled.deferred;
      result.errors.push(...rolled.errors);
      rollupBudget -= rolled.partitions;

      // ── 3. Retention, last and conditionally ────────────────────────────
      const pruned = await applyRetention(deps, storageDir, ref, now);
      result.prunedPartitions += pruned.pruned;
      result.errors.push(...pruned.errors);

      const state = await readTableState(storageDir, ref.corpusDir, ref.table);
      state.lastNightlyWindow = windowKey;
      if (pruned.pruned > 0) {
        state.prunedPartitions = (state.prunedPartitions ?? 0) + pruned.pruned;
      }
      await writeTableState(storageDir, ref.corpusDir, ref.table, state);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push(`${ref.table}: ${message}`);
      log.warn(`nightly maintenance failed for ${projectId}/${ref.table}: ${message}`);
    }
  }
  return result;
}

interface RollupOutcome {
  partitions: number;
  deferred: number;
  errors: string[];
}

/**
 * Materialize each declared rollup, one Parquet file per raw partition.
 *
 * Per-partition rather than whole-table so the work is **incremental**: a
 * corpus with two years of history re-rolls only the days that changed, which
 * is what keeps this a maintenance job rather than a nightly full scan.
 */
async function materializeRollups(
  deps: ObservationNightlyDeps,
  storageDir: string,
  ref: ObservationTableRef,
  budget: number,
): Promise<RollupOutcome> {
  const out: RollupOutcome = { partitions: 0, deferred: 0, errors: [] };
  const rollups = ref.manifest.rollups;
  if (rollups.length === 0 || budget <= 0) return out;

  const tableRoot = await resolveInside(storageDir, tableRelDir(ref.corpusDir, ref.table));
  const rollupRoot = await resolveInside(storageDir, rollupsRelDir(ref.corpusDir, ref.table));
  const partitionDirs = await listPartitions(storageDir, ref.corpusDir, ref.table);
  const state = await readTableState(storageDir, ref.corpusDir, ref.table);
  const watermarks = { ...(state.rollupWatermarks ?? {}) };

  for (const rollup of rollups) {
    const statement = rollup.sql.replaceAll('{{table}}', ROLLUP_SOURCE_VIEW);
    try {
      // Rollup SQL is authored content (a gilde manifest, or one inferred
      // here) rather than model output — but it is still interpolated into a
      // script that runs, so it goes through the same parser gate as a user's
      // query. One extra parse per rollup per night buys the guarantee that a
      // manifest cannot smuggle a second statement.
      await parserCheck(statement, deps.duck, {
        allowedDirectories: [tableRoot],
        timeoutMs: ROLLUP_TIMEOUT_MS,
      });
    } catch (err) {
      out.errors.push(
        `rollup '${rollup.name}' was refused: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    const since = watermarks[rollup.name];
    let materialized = 0;
    for (const partitionDir of partitionDirs) {
      if (out.partitions >= budget) {
        out.deferred += 1;
        continue;
      }
      const needs = await partitionNeedsRollup(
        storageDir,
        ref,
        partitionDir,
        rollup,
        since,
        rollupRoot,
      );
      if (!needs) continue;
      try {
        await materializeOnePartition(deps, {
          ref,
          storageDir,
          tableRoot,
          rollupRoot,
          rollup,
          statement,
          partitionDir,
        });
        out.partitions += 1;
        materialized += 1;
      } catch (err) {
        out.errors.push(
          `rollup '${rollup.name}' ${partitionDir}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    // Advance only when nothing in this rollup failed, so a partial night
    // retries rather than silently skipping the partitions it missed.
    if (materialized > 0 && out.errors.length === 0) watermarks[rollup.name] = nowIso();
  }

  if (Object.keys(watermarks).length > 0) {
    const latest = await readTableState(storageDir, ref.corpusDir, ref.table);
    latest.rollupWatermarks = watermarks;
    await writeTableState(storageDir, ref.corpusDir, ref.table, latest);
  }
  return out;
}

/** Absolute path of one rollup partition's output file. */
function rollupPartitionFile(rollupRoot: string, rollup: string, partitionDir: string): string {
  return join(rollupRoot, rollup, partitionDir, 'part-000000.parquet');
}

/**
 * Does this partition need re-rolling? Yes when the output is missing, or when
 * any of its raw files changed after the rollup last ran.
 */
async function partitionNeedsRollup(
  storageDir: string,
  ref: ObservationTableRef,
  partitionDir: string,
  rollup: ObservationRollup,
  since: string | undefined,
  rollupRoot: string,
): Promise<boolean> {
  const { existsSync, statSync } = await import('node:fs');
  const target = rollupPartitionFile(rollupRoot, rollup.name, partitionDir);
  if (!existsSync(target)) return true;
  if (!since) return true;

  const sinceMs = Date.parse(since);
  if (Number.isNaN(sinceMs)) return true;

  const files = await listPartitionFiles(storageDir, ref.corpusDir, ref.table, partitionDir);
  for (const file of [...files.parquet, ...files.sealed, ...files.open]) {
    try {
      if (statSync(file).mtimeMs > sinceMs) return true;
    } catch {
      /* vanished mid-pass; the next night picks it up */
    }
  }
  return false;
}

async function materializeOnePartition(
  deps: ObservationNightlyDeps,
  args: {
    ref: ObservationTableRef;
    storageDir: string;
    tableRoot: string;
    rollupRoot: string;
    rollup: ObservationRollup;
    statement: string;
    partitionDir: string;
  },
): Promise<void> {
  const { ref, storageDir, tableRoot, rollupRoot, rollup, statement, partitionDir } = args;
  const files = await listPartitionFiles(storageDir, ref.corpusDir, ref.table, partitionDir);
  const sources = buildPartitionSources(ref.manifest, files);
  if (!sources) return;

  const target = rollupPartitionFile(rollupRoot, rollup.name, partitionDir);
  const tmp = `${target}.tmp`;
  const { mkdir, rename, rm: remove } = await import('node:fs/promises');
  await mkdir(join(rollupRoot, rollup.name, partitionDir), { recursive: true });
  await remove(tmp, { force: true });

  await deps.duck.runTrusted(
    `CREATE OR REPLACE VIEW "${ROLLUP_SOURCE_VIEW}" AS ${sources};\n` +
      `COPY (${statement}) TO '${sqlLiteral(tmp)}' (FORMAT parquet, COMPRESSION zstd);`,
    { allowedDirectories: [tableRoot, rollupRoot], timeoutMs: ROLLUP_TIMEOUT_MS },
  );
  await rename(tmp, target);
}

/** A UNION over one partition's Parquet and not-yet-compacted NDJSON. */
function buildPartitionSources(
  manifest: ObservationTableManifest,
  files: { parquet: string[]; sealed: string[]; open: string[] },
): string | null {
  const parts: string[] = [];
  if (files.parquet.length > 0) {
    const list = files.parquet.map((f) => `'${sqlLiteral(f)}'`).join(', ');
    parts.push(`SELECT * FROM read_parquet([${list}], union_by_name = true)`);
  }
  const ndjson = [...files.sealed, ...files.open];
  if (ndjson.length > 0) {
    const list = ndjson.map((f) => `'${sqlLiteral(f)}'`).join(', ');
    const columns = manifest.columns.map((c) => `'${sqlLiteral(c.name)}': '${c.type}'`).join(', ');
    parts.push(`SELECT * FROM read_ndjson([${list}], columns = {${columns}})`);
  }
  return parts.length > 0 ? parts.join(' UNION ALL BY NAME ') : null;
}

interface RetentionOutcome {
  pruned: number;
  errors: string[];
}

/**
 * Delete raw partitions past the table's keep-window.
 *
 * Three conditions, all required. The partition must be older than the
 * window; every declared rollup must already cover it; and it must hold no
 * uncompacted NDJSON. The second and third are what stop this from deleting
 * data that was never summarized — the failure mode has no recovery, since
 * the upstream source's own window has usually moved on.
 */
async function applyRetention(
  deps: ObservationNightlyDeps,
  storageDir: string,
  ref: ObservationTableRef,
  now: Date,
): Promise<RetentionOutcome> {
  const out: RetentionOutcome = { pruned: 0, errors: [] };
  const rawDays = ref.manifest.retention?.rawDays;
  // Absent means keep everything. Deleting a user's mirrored data by
  // omission would be the wrong default.
  if (!rawDays) return out;

  const cutoff = new Date(now.getTime() - rawDays * 86_400_000).toISOString().slice(0, 10);
  const rollupRoot = await resolveInside(storageDir, rollupsRelDir(ref.corpusDir, ref.table));
  const { existsSync } = await import('node:fs');

  for (const partitionDir of await listPartitions(storageDir, ref.corpusDir, ref.table)) {
    const value = partitionValueFromDir(partitionDir)?.value;
    // Only date-shaped partitions age out. An arbitrary partition value has
    // no ordering we can reason about, so it is never pruned.
    if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) continue;
    if (value >= cutoff) continue;

    const files = await listPartitionFiles(storageDir, ref.corpusDir, ref.table, partitionDir);
    if (files.sealed.length > 0 || files.open.length > 0) {
      // Uncompacted rows here have never been rolled up either. Keep them and
      // let the next night compact first.
      continue;
    }

    const covered = ref.manifest.rollups.every((rollup) =>
      existsSync(rollupPartitionFile(rollupRoot, rollup.name, partitionDir)),
    );
    if (!covered) continue;

    try {
      const abs = await resolveInside(
        storageDir,
        `${tableRelDir(ref.corpusDir, ref.table)}/${partitionDir}`,
      );
      await rm(abs, { recursive: true, force: true });
      out.pruned += 1;
      log.info(`retention removed ${ref.table}/${partitionDir} (older than ${rawDays}d)`);
    } catch (err) {
      out.errors.push(
        `retention ${partitionDir}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return out;
}
