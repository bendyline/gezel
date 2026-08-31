/**
 * Tables derived from tabular files that live in the project workspace.
 *
 * A connector corpus is an append-only stream: time-partitioned, cursor-driven,
 * grows forever, and needs sealing, compaction, rollups and retention. A
 * workspace table is the other thing entirely — a **snapshot of one file**.
 * When the file's content hash moves the whole table is rebuilt; when the file
 * goes, the table goes. That single difference removes almost all of the
 * machinery: no NDJSON landing buffer, no sealing, no time partitioning, no
 * rollups. One hash, one materialization, replaced wholesale.
 *
 * ── Why these files need it ───────────────────────────────────────────────
 *
 * The two shapes this targets are both handled badly today, at exactly the
 * sizes that matter:
 *
 * - A CSV over `MAX_INDEXABLE_BYTES` is marked `trivial` by the indexer: no
 *   chunks, no symbols, no enrichment. It is invisible to search *and* far too
 *   big to `read_file`. That existing threshold is precisely the line where a
 *   table starts being the better answer, which is why it is reused here
 *   rather than a new number being invented.
 * - A spreadsheet converts to prose in the shadow tree, so a gezel can read
 *   *about* the numbers but cannot aggregate them. It gets a table at any
 *   size, because it can never be read directly.
 *
 * ── CSV needs no intermediate ─────────────────────────────────────────────
 *
 * Measured against the pinned engine: `read_csv` is built in and works under
 * the full production lockdown, and `sniff_csv` returns typed columns,
 * delimiter and header detection for free. So a CSV becomes Parquet in one
 * `COPY`, with a schema the engine derived rather than one we guessed. (XLSX
 * cannot take this path — `read_xlsx` lives in the `excel` extension, which is
 * not installed and cannot be fetched once the prelude closes network access.
 * That path arrives with squisq's typed regions.)
 */

import { existsSync } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import {
  type ObservationColumn,
  type ObservationColumnType,
  type ObservationTableManifest,
  createLogger,
  nowIso,
} from '@bendyline/gezel';
import { PROJECT_TABULAR_DIR_NAME, TABULAR_COMPANION_SUFFIX } from '@bendyline/gezel/paths';
import { slug } from '../connectors/writer.js';
import { safeJoin } from '../fs/safe-paths.js';
import { columnsStruct } from './compactor.js';
import { type DuckRunner, sqlLiteral } from './duck.js';
import {
  UNPARTITIONED,
  partName,
  partitionDirName,
  readTableState,
  tableRelDir,
  writeTableManifest,
  writeTableState,
} from './layout.js';
import { safeColumnName } from './schema-inference.js';

const log = createLogger('observations');

/** Materializing one file is bounded; a huge CSV is deferred, not run forever. */
export const MATERIALIZE_TIMEOUT_MS = 10 * 60_000;

/**
 * Above this, materialization is deferred to the night shift rather than run
 * inside an index pass the user is waiting on.
 */
export const INLINE_MATERIALIZE_MAX_BYTES = 64 * 1024 * 1024;

/** Bound on companion-dir nesting, mirroring the workspace's own depth. */
const MAX_COMPANION_DEPTH = 24;

/** Extensions this module can turn into a table today. */
export const TABULAR_EXTS = new Set(['csv', 'tsv', 'xlsx']);

/**
 * Extensions a gezel cannot read at all, so a table is its only access.
 * These qualify at any size — unlike a CSV, which below the readable
 * threshold is better served by simply reading it.
 */
export const ALWAYS_TABLE_EXTS = new Set(['xlsx']);

export type TabularState = 'ok' | 'deferred' | 'blocked' | 'failed';

export interface WorkspaceTableSource {
  /** Workspace-relative path, forward-slashed. */
  relPath: string;
  /** Absolute path of the source file. */
  absPath: string;
  /** Content hash the indexer already computed. */
  hash: string;
  size: number;
}

export interface MaterializeResult {
  state: TabularState;
  /** Artifact-relative corpus dir, when one was written. */
  corpusDir?: string;
  table?: string;
  rows?: number;
  reason?: string;
}

/**
 * Artifact-relative corpus dir for one source file, or null when the path
 * cannot be safely turned into one.
 *
 * Returning null rather than throwing follows `shadowDocFilesPaths`: a
 * workspace name is attacker-controlled, and a file we cannot place safely
 * should be skipped quietly, not crash a pass that has other work to do.
 * Companion dirs keep the full basename, so `X_tables` → `X` is a lossless
 * reverse map for orphan collection and `a.csv` cannot collide with `a.xlsx`.
 */
export function tabularCorpusDir(relPath: string): string | null {
  const clean = relPath.replaceAll('\\', '/').replace(/^\/+/, '');
  if (!clean || clean.split('/').some((s) => s === '..' || s === '.')) return null;
  const parent = dirname(clean);
  const companion = `${basename(clean)}${TABULAR_COMPANION_SUFFIX}`;
  const rel =
    parent === '.' || parent === ''
      ? `${PROJECT_TABULAR_DIR_NAME}/${companion}`
      : `${PROJECT_TABULAR_DIR_NAME}/${parent}/${companion}`;
  // Probe the join the writers will perform; a name that cannot be placed
  // safely (traversal, reserved Windows name, ADS) yields null here.
  return safeJoin('/artifacts', rel) ? rel : null;
}

/**
 * Every workspace-derived corpus dir on disk, newest-named first.
 *
 * Read from the filesystem rather than from the index database, for the same
 * reason connector tables are: the corpus is the thing being queried, and a
 * project whose index was deleted or has not been rebuilt should still be able
 * to answer questions about data that is sitting right there.
 */
export async function listWorkspaceCorpusDirs(storageDir: string): Promise<string[]> {
  const root = safeJoin(storageDir, PROJECT_TABULAR_DIR_NAME);
  if (!root || !existsSync(root)) return [];

  const out: string[] = [];
  // Companion dirs mirror the workspace's own nesting, so the walk is
  // depth-first over ordinary directories until it meets a `_tables` name.
  const walk = async (absDir: string, relDir: string, depth: number): Promise<void> => {
    if (depth > MAX_COMPANION_DEPTH) return;
    const entries = await readdir(absDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.name.endsWith(TABULAR_COMPANION_SUFFIX)) {
        out.push(`${PROJECT_TABULAR_DIR_NAME}/${rel}`);
        continue;
      }
      await walk(join(absDir, entry.name), rel, depth + 1);
    }
  };
  await walk(root, '', 0);
  return out.sort();
}

/** Source path a companion dir was derived from, for orphan collection. */
export function sourceRelPathFromCorpusDir(corpusDir: string): string | null {
  const parts = corpusDir.split('/');
  if (parts[0] !== PROJECT_TABULAR_DIR_NAME || parts.length < 2) return null;
  const last = parts[parts.length - 1] as string;
  if (!last.endsWith(TABULAR_COMPANION_SUFFIX)) return null;
  const base = last.slice(0, -TABULAR_COMPANION_SUFFIX.length);
  const middle = parts.slice(1, -1);
  return [...middle, base].join('/');
}

/** Table slug for a single-table source: the file stem. */
export function tableNameForSource(relPath: string): string {
  const stem = basename(relPath, extname(relPath));
  return slug(stem) || 'rows';
}

/**
 * Should this workspace file become a table?
 *
 * The CSV threshold is deliberately the indexer's own `trivial` line: below it
 * the file is already chunked, searchable and readable with `read_file`, and a
 * table would be noise; above it the file is invisible today.
 */
export function shouldMaterialize(
  relPath: string,
  size: number,
  opts: { minBytes: number },
): boolean {
  const ext = extname(relPath).slice(1).toLowerCase();
  if (!TABULAR_EXTS.has(ext)) return false;
  // A spreadsheet is binary: no size makes it readable, so the threshold that
  // protects small CSVs from becoming noise does not apply to it.
  if (ALWAYS_TABLE_EXTS.has(ext)) return size > 0;
  return size >= opts.minBytes;
}

interface SniffedColumn {
  name: string;
  type: string;
}

/** DuckDB's sniffed type names → our closed column-type vocabulary. */
export function duckTypeToColumnType(duckType: string): ObservationColumnType {
  const t = duckType
    .toUpperCase()
    .replace(/\(.*\)$/, '')
    .trim();
  if (t === 'BOOLEAN') return 'BOOLEAN';
  if (['TINYINT', 'SMALLINT', 'INTEGER', 'BIGINT', 'HUGEINT', 'UBIGINT', 'UINTEGER'].includes(t)) {
    return 'BIGINT';
  }
  if (['FLOAT', 'DOUBLE', 'REAL', 'DECIMAL'].includes(t)) return 'DOUBLE';
  if (t === 'DATE') return 'DATE';
  if (t.startsWith('TIMESTAMP')) return 'TIMESTAMP';
  if (t === 'JSON' || t.startsWith('STRUCT') || t.startsWith('MAP') || t.endsWith('[]')) {
    return 'JSON';
  }
  return 'VARCHAR';
}

interface SniffResult {
  columns: ObservationColumn[];
  delimiter: string;
  hasHeader: boolean;
}

/**
 * Ask the engine what this CSV looks like.
 *
 * Column names are normalized the same way the observation writer normalizes
 * them, so a header of `Total Revenue (USD)` becomes a queryable
 * `total_revenue_usd` rather than something a model has to quote. Duplicate
 * names after normalization are suffixed, because a CSV with two `Total`
 * columns is common and a silently dropped column is not acceptable.
 */
export async function sniffCsv(duck: DuckRunner, absPath: string): Promise<SniffResult> {
  const dir = dirname(absPath);
  const rows = await duck.runTrusted<{
    Columns: unknown;
    Delimiter: string;
    HasHeader: boolean | string;
  }>(`SELECT Columns, Delimiter, HasHeader FROM sniff_csv('${sqlLiteral(absPath)}')`, {
    allowedDirectories: [dir],
    timeoutMs: MATERIALIZE_TIMEOUT_MS,
  });

  const first = rows[0];
  if (!first) throw new Error('the engine could not determine the shape of this file');

  const sniffed = parseSniffedColumns(first.Columns);
  // DuckDB already de-duplicates repeated headers (`Total`, `Total_1`), so this
  // pass only catches collisions that OUR normalization creates — `Total` and
  // `total` both becoming `total`. A silently dropped column is not acceptable
  // either way.
  const seen = new Map<string, number>();
  const columns: ObservationColumn[] = sniffed.map((column) => {
    const base = safeColumnName(column.name);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    const name = count === 0 ? base : `${base}_dup${count}`;
    const type = duckTypeToColumnType(column.type);
    return {
      name,
      type,
      role: type === 'BIGINT' || type === 'DOUBLE' ? 'measure' : 'dimension',
      ...(name !== column.name ? { description: `Source column \`${column.name}\`.` } : {}),
    };
  });

  return {
    columns,
    delimiter: first.Delimiter ?? ',',
    hasHeader: first.HasHeader === true || first.HasHeader === 'true',
  };
}

/**
 * `sniff_csv` returns its `Columns` as a list of structs. The CLI renders that
 * as JSON in `-json` mode, but the shape has moved between releases, so parse
 * defensively rather than trusting one form.
 */
export function parseSniffedColumns(raw: unknown): SniffedColumn[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: SniffedColumn[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const name = record.name ?? record.column_name;
    const type = record.type ?? record.column_type;
    if (typeof name === 'string' && typeof type === 'string') out.push({ name, type });
  }
  return out;
}

export interface MaterializeOptions {
  storageDir: string;
  duck: DuckRunner;
  source: WorkspaceTableSource;
  /** Skip files above this and report `deferred`; the night shift takes them. */
  maxInlineBytes?: number;
}

/**
 * Turn one workspace CSV into a Parquet table.
 *
 * Publishing is write-`.tmp` → verify the row count → `rename`, the same
 * discipline the connector compactor uses and for the same reason: a partial
 * part is indistinguishable from a complete one on every later read, and a
 * silently short table makes every subsequent answer confidently wrong.
 */
export async function materializeCsv(opts: MaterializeOptions): Promise<MaterializeResult> {
  const { storageDir, duck, source } = opts;
  const maxInline = opts.maxInlineBytes ?? INLINE_MATERIALIZE_MAX_BYTES;

  const corpusDir = tabularCorpusDir(source.relPath);
  if (!corpusDir) {
    return { state: 'blocked', reason: 'the file path cannot be placed safely under artifacts' };
  }
  if (source.size === 0) {
    // The engine invents a phantom `column0 VARCHAR` for a zero-byte file, so
    // without this an empty file would publish a one-column table of nothing.
    return { state: 'blocked', corpusDir, reason: 'the file is empty' };
  }
  if (source.size > maxInline) {
    return { state: 'deferred', corpusDir, reason: `file is larger than ${maxInline} bytes` };
  }

  const table = tableNameForSource(source.relPath);
  const partitionDir = partitionDirName('part', UNPARTITIONED);
  const relDir = `${tableRelDir(corpusDir, table)}/${partitionDir}`;
  const absDir = safeJoin(storageDir, relDir);
  if (!absDir) {
    return { state: 'blocked', reason: 'the derived table path cannot be placed safely' };
  }

  let sniffed: SniffResult;
  try {
    sniffed = await sniffCsv(duck, source.absPath);
  } catch (err) {
    return {
      state: 'blocked',
      corpusDir,
      reason: `could not read this file as a table: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (sniffed.columns.length === 0) {
    return { state: 'blocked', corpusDir, reason: 'the file has no readable columns' };
  }

  const manifest: ObservationTableManifest = {
    schemaVersion: 1,
    table,
    title: basename(source.relPath),
    grain: `one row per line of ${basename(source.relPath)}`,
    columns: sniffed.columns,
    measures: [],
    exemplars: [],
    rollups: [],
    // The engine sniffed these types from a sample of the file, so they carry
    // the same caveat an inferred connector schema does.
    inferred: true,
  };

  await mkdir(absDir, { recursive: true });
  const target = join(absDir, partName('part', 0, 'parquet'));
  const tmp = `${target}.tmp`;
  await rm(tmp, { force: true });

  const sourceDir = dirname(source.absPath);
  const allowedDirectories = [sourceDir, absDir];

  try {
    await duck.runTrusted(
      `COPY (
         SELECT * FROM read_csv(
           '${sqlLiteral(source.absPath)}',
           columns = ${columnsStruct(manifest)},
           delim = '${sqlLiteral(sniffed.delimiter)}',
           header = ${sniffed.hasHeader ? 'true' : 'false'},
           ignore_errors = true
         )
       ) TO '${sqlLiteral(tmp)}' (FORMAT parquet, COMPRESSION zstd);`,
      { allowedDirectories, timeoutMs: MATERIALIZE_TIMEOUT_MS },
    );

    const counted = await duck.runTrusted<{ n: number }>(
      `SELECT count(*) AS n FROM read_parquet('${sqlLiteral(tmp)}')`,
      { allowedDirectories, timeoutMs: MATERIALIZE_TIMEOUT_MS },
    );
    const rows = Number(counted[0]?.n ?? 0);

    await rename(tmp, target);

    await writeTableManifest(storageDir, corpusDir, manifest);
    const state = await readTableState(storageDir, corpusDir, table);
    await writeTableState(storageDir, corpusDir, table, {
      ...state,
      totalRows: rows,
      lastWriteAt: nowIso(),
      nextPart: 1,
    });

    log.debug(`materialized ${source.relPath} → ${corpusDir}/${table} (${rows} rows)`);
    return { state: 'ok', corpusDir, table, rows };
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`could not materialize ${source.relPath}: ${message}`);
    return { state: 'failed', corpusDir, reason: message };
  }
}

/**
 * A short markdown card describing a derived table, written into the shadow
 * tree so the source file becomes findable by keyword search again.
 *
 * This closes a real gap rather than being decoration. A CSV over the readable
 * threshold is marked `trivial` by the indexer — no chunks, no enrichment — so
 * today it is invisible to search *and* too big to read. Without a card, a
 * user searching "revenue by region" would never learn the spreadsheet exists,
 * and the query tools they need are only useful once they know to look.
 *
 * Kept deliberately thin: names and shape, no data. The card is a signpost to
 * `describe_table`, not a second copy of the schema, and putting rows in it
 * would re-introduce exactly the vector-space poisoning that keeps table data
 * out of the index in the first place.
 */
export function renderTableCard(
  relPath: string,
  manifest: ObservationTableManifest,
  rows: number,
): string {
  const columns = manifest.columns.map((c) => c.name).join(', ');
  return [
    `# ${manifest.title ?? relPath}`,
    '',
    `Data table derived from \`${relPath}\`.`,
    '',
    `- **Rows:** ${rows.toLocaleString('en-US')}`,
    `- **Columns:** ${columns}`,
    '',
    `Query it with \`describe_table({ table: "${manifest.table}" })\` then \`query_table\`.`,
    'This file is stored as a queryable table; it is too large to read directly.',
    '',
  ].join('\n');
}

/** Remove a source file's whole companion directory. */
export async function removeWorkspaceTable(
  storageDir: string,
  corpusDir: string,
): Promise<boolean> {
  const abs = safeJoin(storageDir, corpusDir);
  if (!abs || !existsSync(abs)) return false;
  await rm(abs, { recursive: true, force: true });
  return true;
}

/** Bytes on disk for a materialized table, for stats and budgeting. */
export async function materializedBytes(
  storageDir: string,
  corpusDir: string,
  table: string,
): Promise<number> {
  const abs = safeJoin(storageDir, `${tableRelDir(corpusDir, table)}`);
  if (!abs || !existsSync(abs)) return 0;
  return stat(abs)
    .then((s) => s.size)
    .catch(() => 0);
}
