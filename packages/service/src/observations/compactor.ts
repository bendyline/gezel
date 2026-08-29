/**
 * Turn sealed NDJSON parts into Parquet, using the bundled DuckDB CLI.
 *
 * This is why gezel carries no Parquet encoder: the engine it already ships
 * for *querying* does the writing too. One `COPY (SELECT … FROM read_ndjson(…))
 * TO … (FORMAT parquet)` per part, and the dependency count stays at one.
 *
 * Two rules the implementation exists to enforce:
 *
 * 1. **Always pass explicit `columns = {…}` from the manifest.** Never
 *    `read_json_auto` here. Auto-typing decides each file's schema in
 *    isolation, so a column that is integral in Monday's part and fractional
 *    in Tuesday's produces two mutually unreadable files — and the failure
 *    surfaces later, as a glob read error that looks like corruption rather
 *    than like a schema drift. The manifest is the single source of truth and
 *    the writer already coerced the rows to it.
 *
 * 2. **Verify before publishing.** The Parquet part's row count must equal the
 *    NDJSON's line count. A torn append (the process died mid-write) or a
 *    truncated page otherwise becomes a smaller, perfectly valid Parquet file,
 *    and silent row loss in an analytics corpus is the worst possible failure:
 *    every later answer is confidently wrong. On mismatch both files are left
 *    in place and the error is recorded, so the next pass can retry and a
 *    human can look.
 *
 * Publishing is `write to .tmp` → verify → `rename` → delete the NDJSON. The
 * rename is atomic, so a reader never sees a partial part.
 */

import { existsSync } from 'node:fs';
import { rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { createLogger, nowIso, type ObservationTableManifest } from '@bendyline/gezel';
import { DuckQueryError, type DuckRunOptions, sqlLiteral } from './duck.js';
import {
  listPartitionFiles,
  listPartitions,
  listTables,
  readTableManifest,
  readTableState,
  writeTableState,
} from './layout.js';
import { resolveInside } from '../fs/safe-paths.js';
import { tableRelDir } from './layout.js';

const log = createLogger('observations');

/** Generous: compaction is I/O-bound and runs off the interactive path. */
export const COMPACTION_TIMEOUT_MS = 10 * 60_000;

/**
 * The slice of {@link DuckRunner} compaction needs. Narrowed to an interface
 * so the row-count verification can be tested against controlled counts: the
 * guard exists for the case where the engine's answer disagrees with the
 * source, and that disagreement cannot be staged reliably with a real engine
 * (a short-but-valid NDJSON file compacts to a short-but-valid Parquet one).
 */
export interface DuckLike {
  runTrusted<Row = Record<string, unknown>>(sql: string, opts: DuckRunOptions): Promise<Row[]>;
}

export interface CompactionResult {
  table: string;
  partsCompacted: number;
  rowsCompacted: number;
  /** Parts left in place because they failed verification. */
  partsFailed: number;
  errors: string[];
}

export interface CompactOptions {
  storageDir: string;
  corpusDir: string;
  duck: DuckLike;
  /** Restrict to one table; default is every table in the corpus. */
  table?: string;
  /** Cap parts per invocation so a nightly pass stays bounded. */
  maxParts?: number;
}

/**
 * Render the manifest's columns as DuckDB's `columns = {…}` struct.
 *
 * Column names and types are both validated by the manifest schema (snake_case
 * identifiers, a closed type enum), which is what makes this interpolation
 * safe — the values can never carry arbitrary text into the statement.
 */
export function columnsStruct(manifest: ObservationTableManifest): string {
  const entries = manifest.columns.map((c) => `'${sqlLiteral(c.name)}': '${c.type}'`);
  return `{${entries.join(', ')}}`;
}

/** Compact every sealed part in a corpus (or one table of it). */
export async function compactCorpus(opts: CompactOptions): Promise<CompactionResult[]> {
  const tables = opts.table ? [opts.table] : await listTables(opts.storageDir, opts.corpusDir);
  const results: CompactionResult[] = [];
  let budget = opts.maxParts ?? Number.POSITIVE_INFINITY;

  for (const table of tables) {
    if (budget <= 0) break;
    const result = await compactTable({ ...opts, table, maxParts: budget });
    budget -= result.partsCompacted + result.partsFailed;
    results.push(result);
  }
  return results;
}

async function compactTable(opts: CompactOptions & { table: string }): Promise<CompactionResult> {
  const { storageDir, corpusDir, duck, table } = opts;
  const result: CompactionResult = {
    table,
    partsCompacted: 0,
    rowsCompacted: 0,
    partsFailed: 0,
    errors: [],
  };

  const manifest = await readTableManifest(storageDir, corpusDir, table);
  if (!manifest) {
    result.errors.push(`table '${table}' has no readable manifest; skipping compaction`);
    return result;
  }

  const state = await readTableState(storageDir, corpusDir, table);
  const tableRoot = await resolveInside(storageDir, tableRelDir(corpusDir, table));
  let budget = opts.maxParts ?? Number.POSITIVE_INFINITY;

  for (const partitionDir of await listPartitions(storageDir, corpusDir, table)) {
    if (budget <= 0) break;
    const files = await listPartitionFiles(storageDir, corpusDir, table, partitionDir);
    for (const sealed of files.sealed) {
      if (budget <= 0) break;
      budget -= 1;
      try {
        const rows = await compactPart({ duck, manifest, sealed, tableRoot });
        result.partsCompacted += 1;
        result.rowsCompacted += rows;
      } catch (err) {
        result.partsFailed += 1;
        const message = err instanceof Error ? err.message : String(err);
        result.errors.push(`${basename(sealed)}: ${message}`);
        log.warn(`compaction failed for ${table}/${partitionDir}/${basename(sealed)}: ${message}`);
      }
    }
  }

  if (result.partsCompacted > 0 || result.partsFailed > 0) {
    state.lastCompactionAt = nowIso();
    if (result.errors.length > 0) state.lastError = result.errors[0];
    else delete state.lastError;
    await writeTableState(storageDir, corpusDir, table, state);
  }
  return result;
}

async function compactPart(args: {
  duck: DuckLike;
  manifest: ObservationTableManifest;
  sealed: string;
  tableRoot: string;
}): Promise<number> {
  const { duck, manifest, sealed, tableRoot } = args;
  const partitionDirAbs = dirname(sealed);
  // `sealed-000123.ndjson` → `part-000123.parquet`, keeping the ordinal so a
  // part's identity survives the format change.
  const ordinalPart = basename(sealed).replace(/^sealed-/, 'part-').replace(/\.ndjson$/, '');
  const target = join(partitionDirAbs, `${ordinalPart}.parquet`);
  const tmp = `${target}.tmp`;

  if (existsSync(target)) {
    // A previous run published this part and died before unlinking its source.
    // Finish the cleanup rather than duplicating the rows.
    await rm(sealed, { force: true });
    return 0;
  }

  await rm(tmp, { force: true });

  const expectedRows = await countNdjsonRows(duck, sealed, tableRoot);

  await duck.runTrusted(
    `COPY (
       SELECT * FROM read_ndjson('${sqlLiteral(sealed)}', columns = ${columnsStruct(manifest)})
     ) TO '${sqlLiteral(tmp)}' (FORMAT parquet, COMPRESSION zstd);`,
    { allowedDirectories: [tableRoot], timeoutMs: COMPACTION_TIMEOUT_MS },
  );

  const written = await countParquetRows(duck, tmp, tableRoot);
  if (written !== expectedRows) {
    // Leave BOTH files. The NDJSON is the only copy of the difference, and a
    // partial Parquet published here would be indistinguishable from a
    // complete one on every subsequent read.
    await rm(tmp, { force: true });
    throw new Error(
      `row count mismatch: ${expectedRows} row(s) in the source part, ${written} in the Parquet output — source kept for retry`,
    );
  }

  await rename(tmp, target);
  await rm(sealed, { force: true });
  return written;
}

async function countNdjsonRows(
  duck: DuckLike,
  file: string,
  allowedDir: string,
): Promise<number> {
  // Counted by the engine rather than by reading the file in Node: the part is
  // sized for Parquet (tens of MB), and it would otherwise be read twice.
  const rows = await duck.runTrusted<{ n: number }>(
    `SELECT count(*) AS n FROM read_ndjson('${sqlLiteral(file)}', columns = {'__gezel_probe': 'JSON'}, ignore_errors = false)`,
    { allowedDirectories: [allowedDir], timeoutMs: COMPACTION_TIMEOUT_MS },
  ).catch(async (err) => {
    if (err instanceof DuckQueryError) {
      // A probe column the data does not have still counts lines in most
      // shapes, but not all. Fall back to a line count over the raw text.
      const lines = await duck.runTrusted<{ n: number }>(
        `SELECT count(*) AS n FROM read_csv('${sqlLiteral(file)}', header = false, columns = {'line': 'VARCHAR'}, delim = '\\x07', quote = '', escape = '')`,
        { allowedDirectories: [allowedDir], timeoutMs: COMPACTION_TIMEOUT_MS },
      );
      return lines;
    }
    throw err;
  });
  return Number(rows[0]?.n ?? 0);
}

async function countParquetRows(
  duck: DuckLike,
  file: string,
  allowedDir: string,
): Promise<number> {
  if (!existsSync(file)) return 0;
  if ((await stat(file)).size === 0) return 0;
  const rows = await duck.runTrusted<{ n: number }>(
    `SELECT count(*) AS n FROM read_parquet('${sqlLiteral(file)}')`,
    { allowedDirectories: [allowedDir], timeoutMs: COMPACTION_TIMEOUT_MS },
  );
  return Number(rows[0]?.n ?? 0);
}
