/**
 * The drain: turn the tabular files the index pass enrolled into tables.
 *
 * Split from `workspace-tables.ts` (which materializes one file) and from the
 * index pass (which enumerates and hashes) because of where each can run. The
 * static pass executes inside a worker thread, and spawning a DuckDB child per
 * file from there on every pass would be heavy; this runs on the service side,
 * after the pass, where `DuckRunner` already lives.
 *
 * The pass therefore *enrols and hashes*; this *converts*; the night shift
 * picks up what a size budget deferred. Each stage keeps the guarantee the one
 * before it established — in particular the content hash, which is what makes
 * a rebuild happen exactly when a file's bytes change and not merely when its
 * mtime moves.
 */

import { join } from 'node:path';
import { createLogger } from '@bendyline/gezel';
import { MAX_INDEXABLE_BYTES } from '../index-store/classify.js';
import { shadowDocFilesPaths, writeConvertedMarkdownAt } from '../index-store/docs.js';
import type { IndexStore } from '../index-store/index-store.js';
import { convertInSandbox } from '../index-store/sandbox-convert.js';
import type { DuckRunner } from './duck.js';
import { readTableManifest } from './layout.js';
import {
  ALWAYS_TABLE_EXTS,
  INLINE_MATERIALIZE_MAX_BYTES,
  TABULAR_EXTS,
  materializeCsv,
  removeWorkspaceTable,
  renderTableCard,
  sourceRelPathFromCorpusDir,
  tabularCorpusDir,
} from './workspace-tables.js';
import { materializeWorkbook } from './workspace-xlsx.js';

const log = createLogger('observations');

/**
 * Files converted per drain. A project that has just had a data folder dropped
 * into it should not spend an unbounded pass converting; the remainder is
 * picked up on the next tick and by the night shift.
 */
export const MAX_TABLES_PER_DRAIN = 12;

/**
 * Ceiling on tables one project may hold. A fixture-heavy repo would otherwise
 * produce hundreds, drowning `list_tables` — the surface this feature exists to
 * make useful. Overflow is logged, never silent.
 */
export const MAX_TABLES_PER_PROJECT = 200;

/**
 * Night budgets. Nobody is waiting on the pass, so the size ceiling that keeps
 * a huge file off the interactive path lifts, and the per-run cap widens to
 * drain a backlog in one window rather than over days of index refreshes.
 */
export const NIGHT_MAX_TABLES_PER_DRAIN = 200;
export const NIGHT_MAX_INLINE_BYTES = 8 * 1024 * 1024 * 1024;

/** Attempts per content hash before a file is left alone until it changes. */
export const MAX_TABULAR_ATTEMPTS = 3;

export interface DrainOptions {
  store: IndexStore;
  duck: DuckRunner;
  /** Project artifacts root — where tables are written. */
  storageDir: string;
  /** Resolved workspace root — where the source files live. */
  workspaceDir: string;
  /** Convert at most this many files; the rest wait for the next tick. */
  maxTables?: number;
  /** Files above this are recorded `deferred` for the night shift. */
  maxInlineBytes?: number;
  /** Byte floor below which a file stays an ordinary readable file. */
  minBytes?: number;
}

export interface DrainResult {
  materialized: number;
  rows: number;
  deferred: number;
  blocked: number;
  failed: number;
  swept: number;
  /** Work the per-drain cap left behind, so truncation is never silent. */
  remaining: number;
}

/**
 * Materialize newly-changed tabular files, then sweep tables whose source is
 * gone.
 *
 * Never throws: a data file that cannot be read must not take down the index
 * pass that called this, and the outcome is recorded per hash so a bad file
 * costs at most `MAX_TABULAR_ATTEMPTS` conversions rather than one per pass
 * forever.
 */
export async function drainWorkspaceTables(opts: DrainOptions): Promise<DrainResult> {
  const {
    store,
    duck,
    storageDir,
    workspaceDir,
    maxTables = MAX_TABLES_PER_DRAIN,
    maxInlineBytes = INLINE_MATERIALIZE_MAX_BYTES,
    minBytes = MAX_INDEXABLE_BYTES,
  } = opts;

  const result: DrainResult = {
    materialized: 0,
    rows: 0,
    deferred: 0,
    blocked: 0,
    failed: 0,
    swept: 0,
    remaining: 0,
  };

  // Sweeping first keeps the project-wide cap honest: a deleted file's slot is
  // freed before a new file is refused for being over the limit.
  result.swept = await sweepOrphanedTables(store, storageDir);

  if (!duck.available()) {
    // Nothing is lost — the files stay enrolled and unconverted, and the next
    // drain after the engine is installed picks them all up.
    return result;
  }

  const existing = store.listTabularCorpusDirs().length;
  if (existing >= MAX_TABLES_PER_PROJECT) {
    log.warn(
      `project already holds ${existing} derived tables (cap ${MAX_TABLES_PER_PROJECT}); skipping further conversion`,
    );
    return result;
  }

  const work = store.listTabularWork(
    [...TABULAR_EXTS],
    minBytes,
    MAX_TABULAR_ATTEMPTS,
    maxTables + 1,
    [...ALWAYS_TABLE_EXTS],
  );
  if (work.length > maxTables) result.remaining = work.length - maxTables;

  let budget = Math.min(maxTables, MAX_TABLES_PER_PROJECT - existing);
  for (const file of work) {
    if (budget <= 0) break;
    budget -= 1;
    try {
      const source = {
        relPath: file.path,
        absPath: join(workspaceDir, file.path),
        hash: file.hash,
        size: file.size,
      };
      // A spreadsheet cannot go through DuckDB — `read_xlsx` lives in an
      // extension our lockdown cannot load — so it takes the sandboxed
      // squisq route and lands several tables, one per data island.
      const outcome = file.path.toLowerCase().endsWith('.xlsx')
        ? await materializeWorkbook({
            storageDir,
            duck,
            source,
            extract: async (absPath) => {
              const res = await convertInSandbox(absPath, 'xlsx', 'tables');
              return {
                ndjson: res.ndjson ?? null,
                ...(res.blocked ? { blocked: res.blocked } : {}),
              };
            },
          })
        : await materializeCsv({ storageDir, duck, maxInlineBytes, source });

      if (outcome.state === 'ok') {
        store.markTabularOk(file.hash, file.path, outcome.corpusDir as string, outcome.rows ?? 0);
        result.materialized += 1;
        result.rows += outcome.rows ?? 0;
        await writeTableCard(opts, file.path, outcome).catch(() => {
          /* the card is a signpost; failing to write one must not fail the table */
        });
      } else {
        store.markTabularOutcome(
          file.hash,
          file.path,
          outcome.state,
          outcome.reason,
          outcome.corpusDir,
        );
        if (outcome.state === 'deferred') result.deferred += 1;
        else if (outcome.state === 'blocked') result.blocked += 1;
        else result.failed += 1;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      store.markTabularOutcome(file.hash, file.path, 'failed', message);
      result.failed += 1;
      log.warn(`table conversion failed for ${file.path}: ${message}`);
    }
  }

  if (result.materialized > 0 || result.swept > 0) {
    log.info(
      `derived tables: ${result.materialized} built (${result.rows} rows), ${result.swept} swept${result.remaining > 0 ? `, ${result.remaining} queued` : ''}`,
    );
  }
  return result;
}

/**
 * Write the shadow card for a freshly built table.
 *
 * Reuses the shadow tree's own placement helpers, so the card lands beside the
 * markdown twin the indexer already writes for a spreadsheet and is swept by
 * the same orphan collector when the source goes.
 */
async function writeTableCard(
  opts: DrainOptions,
  relPath: string,
  outcome: { corpusDir?: string; table?: string; rows?: number },
): Promise<void> {
  if (!outcome.corpusDir || !outcome.table) return;
  const manifest = await readTableManifest(opts.storageDir, outcome.corpusDir, outcome.table);
  if (!manifest) return;
  const paths = shadowDocFilesPaths(opts.storageDir, relPath);
  // Null means the workspace name cannot be safely shadowed; the table itself
  // is already written, so this is a missing signpost, not a failure.
  if (!paths) return;
  await writeConvertedMarkdownAt(paths, renderTableCard(relPath, manifest, outcome.rows ?? 0));
}

/**
 * Remove tables whose source file is no longer enrolled.
 *
 * The reverse map is lossless because a companion directory keeps the source's
 * full basename — the same reason the shadow tree keys on `X_files`. Without
 * that, a deleted `sales.csv` and a live `sales.xlsx` would be
 * indistinguishable and the sweep would take the wrong one.
 */
export async function sweepOrphanedTables(store: IndexStore, storageDir: string): Promise<number> {
  const live = new Set(store.allFilePaths());
  let swept = 0;
  for (const row of store.listTabularCorpusDirs()) {
    const source = sourceRelPathFromCorpusDir(row.corpusDir) ?? row.filePath;
    if (live.has(source)) continue;
    if (await removeWorkspaceTable(storageDir, row.corpusDir).catch(() => false)) swept += 1;
    // Drop the gate row too, so the file re-appearing rebuilds from scratch
    // rather than being skipped by a stale 'ok'.
    store.clearTabularStateForPath(row.filePath);
  }
  return swept;
}

/** True when a corpus dir belongs to a workspace-derived table. */
export function isWorkspaceTableCorpus(corpusDir: string): boolean {
  return tabularCorpusDir(corpusDir) !== null || corpusDir.startsWith('tabular/');
}
