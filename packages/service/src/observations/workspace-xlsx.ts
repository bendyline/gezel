/**
 * Spreadsheets → tables.
 *
 * A CSV has one shape and DuckDB reads it directly. A workbook has neither
 * property: it is a binary container the engine cannot open under our
 * lockdown, and a *sheet is not a table* — it is several data islands with
 * captions, notes and totals scattered in the gaps. squisq solves both, so
 * this module is the join between its typed output and the Parquet writer.
 *
 * Three decisions worth keeping:
 *
 * - **Values, never display text.** squisq's markdown rendering turns a
 *   percent-formatted `0.15` into `"15.0%"`, a date into localized text and a
 *   zero-padded `7` into `"007"`. Those are renderings for people. The typed
 *   export carries the underlying values, which is the only reason a sum over
 *   a spreadsheet column can be trusted.
 * - **One table per island, not per sheet.** Importing a sheet's whole used
 *   range as one table makes `A1` the header for all of it and turns every gap
 *   into blank rows.
 * - **Every size qualifies.** Unlike a CSV — readable as text below the
 *   indexer's threshold — a workbook is binary. A gezel cannot read it at any
 *   size, so the table is the only access it will ever have.
 */

import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  type ObservationColumn,
  type ObservationColumnType,
  type ObservationTableManifest,
  createLogger,
  nowIso,
} from '@bendyline/gezel';
import { safeJoin } from '../fs/safe-paths.js';
import { slug } from '../connectors/writer.js';
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
import {
  MATERIALIZE_TIMEOUT_MS,
  type MaterializeResult,
  type WorkspaceTableSource,
  tabularCorpusDir,
} from './workspace-tables.js';

const log = createLogger('observations');

/** Tables extracted from one workbook before a size guard kicks in. */
export const MAX_TABLES_PER_WORKBOOK = 64;

/** What the sandboxed worker emits, one per NDJSON line. */
export interface ExtractedTable {
  sheet: string;
  anchor: string;
  title?: string;
  columns: { name: string; kind: string }[];
  hasHeader: boolean;
  rows: (string | number | boolean | null)[][];
}

/** squisq's cell-kind vocabulary → ours. */
export function cellKindToColumnType(kind: string): ObservationColumnType {
  switch (kind) {
    case 'number':
      return 'DOUBLE';
    case 'bool':
      return 'BOOLEAN';
    case 'date':
      // squisq normalizes dates to ISO `YYYY-MM-DD` (or `… HH:MM`), so the
      // wider type reads both without a format string.
      return 'TIMESTAMP';
    default:
      // string, error, empty, and `mixed` — a column that genuinely holds more
      // than one kind is text, because any narrower choice would drop values.
      return 'VARCHAR';
  }
}

/** Parse the worker's NDJSON, skipping any line it could not write cleanly. */
export function parseExtractedTables(ndjson: string): ExtractedTable[] {
  const out: ExtractedTable[] = [];
  for (const line of ndjson.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as ExtractedTable;
      if (Array.isArray(parsed.columns) && Array.isArray(parsed.rows)) out.push(parsed);
    } catch {
      // A truncated final line costs that table, not the workbook.
      log.warn('skipping an unreadable table line from the spreadsheet worker');
    }
  }
  return out;
}

/**
 * Table slug for one island.
 *
 * A workbook yields several tables, so the name has to distinguish them
 * without being noise. The region's caption is what a person would call it;
 * the sheet name is the next best thing; the anchor disambiguates two islands
 * on one sheet. `Q3 Revenue` on sheet `Sales` becomes `q3-revenue`, and a
 * nameless island becomes `sales-f4`.
 */
export function tableNameForRegion(table: ExtractedTable, taken: Set<string>): string {
  // `slug` never returns an empty string — it falls back to 'x' — so the
  // choice has to be made on the source values, not on their slugs.
  const anchor = table.anchor.toLowerCase();
  const base = table.title?.trim()
    ? slug(table.title)
    : table.sheet.trim()
      ? `${slug(table.sheet)}-${anchor}`
      : `sheet-${anchor}`;
  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }
  // Two islands with the same caption: the anchor is what tells them apart.
  const qualified = `${base}-${anchor}`;
  let name = qualified;
  let n = 2;
  while (taken.has(name)) name = `${qualified}-${n++}`;
  taken.add(name);
  return name;
}

/** Build a manifest from squisq's typed columns. */
export function manifestForTable(
  table: ExtractedTable,
  tableName: string,
  sourceRel: string,
): ObservationTableManifest {
  const seen = new Map<string, number>();
  const columns: ObservationColumn[] = table.columns.map((column) => {
    const base = safeColumnName(column.name);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    const name = count === 0 ? base : `${base}_dup${count}`;
    const type = cellKindToColumnType(column.kind);
    return {
      name,
      type,
      role: type === 'DOUBLE' || type === 'BIGINT' ? 'measure' : 'dimension',
      ...(name !== column.name ? { description: `Spreadsheet column \`${column.name}\`.` } : {}),
    };
  });

  return {
    schemaVersion: 1,
    table: tableName,
    title: table.title ?? `${basename(sourceRel)} — ${table.sheet}`,
    description: `Sheet \`${table.sheet}\`, starting at cell ${table.anchor} of \`${sourceRel}\`.`,
    grain: 'one row per spreadsheet row',
    columns,
    measures: [],
    exemplars: [],
    rollups: [],
    // squisq reports each column's dominant cell kind, which is a better guess
    // than sniffing text — but still a guess about a human-authored sheet.
    inferred: true,
  };
}

export interface MaterializeWorkbookOptions {
  storageDir: string;
  duck: DuckRunner;
  source: WorkspaceTableSource;
  /** Runs the sandboxed extraction. Injected so tests need no real workbook. */
  extract: (absPath: string) => Promise<{ ndjson: string | null; blocked?: string }>;
  maxTables?: number;
}

export interface WorkbookResult extends MaterializeResult {
  /** Tables written, when the workbook yielded any. */
  tables?: string[];
}

/**
 * Extract a workbook's islands and write each as its own Parquet table.
 *
 * Rows go to NDJSON first and DuckDB converts them, rather than being encoded
 * directly: the engine gezel already ships for querying is also the only
 * Parquet writer it has, which is what keeps the dependency count at one.
 */
export async function materializeWorkbook(
  opts: MaterializeWorkbookOptions,
): Promise<WorkbookResult> {
  const { storageDir, duck, source, extract } = opts;
  const maxTables = opts.maxTables ?? MAX_TABLES_PER_WORKBOOK;

  const corpusDir = tabularCorpusDir(source.relPath);
  if (!corpusDir) {
    return { state: 'blocked', reason: 'the file path cannot be placed safely under artifacts' };
  }

  const extracted = await extract(source.absPath);
  if (extracted.blocked) return { state: 'blocked', corpusDir, reason: extracted.blocked };
  // `null` means the extraction failed and may succeed on retry; an empty
  // string means it ran fine and the workbook simply holds no tables. Those
  // are different outcomes — conflating them would retry a spreadsheet of
  // notes on every pass forever.
  if (extracted.ndjson === null || extracted.ndjson === undefined) {
    return { state: 'failed', corpusDir, reason: 'the spreadsheet could not be read' };
  }

  const tables = parseExtractedTables(extracted.ndjson);
  if (tables.length === 0) {
    return { state: 'blocked', corpusDir, reason: 'the spreadsheet holds no table-shaped data' };
  }

  const taken = new Set<string>();
  const written: string[] = [];
  let rows = 0;

  for (const table of tables.slice(0, maxTables)) {
    if (table.rows.length === 0) continue;
    const name = tableNameForRegion(table, taken);
    const manifest = manifestForTable(table, name, source.relPath);
    try {
      rows += await writeTableParquet({ storageDir, duck, corpusDir, manifest, table });
      written.push(name);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`could not write ${source.relPath} → ${name}: ${message}`);
    }
  }

  if (written.length === 0) {
    return { state: 'failed', corpusDir, reason: 'no table from this spreadsheet could be written' };
  }
  if (tables.length > maxTables) {
    log.warn(
      `${source.relPath} holds ${tables.length} tables; only the first ${maxTables} were kept`,
    );
  }
  return { state: 'ok', corpusDir, table: written[0], tables: written, rows };
}

async function writeTableParquet(args: {
  storageDir: string;
  duck: DuckRunner;
  corpusDir: string;
  manifest: ObservationTableManifest;
  table: ExtractedTable;
}): Promise<number> {
  const { storageDir, duck, corpusDir, manifest, table } = args;

  const partitionDir = partitionDirName('part', UNPARTITIONED);
  const relDir = `${tableRelDir(corpusDir, manifest.table)}/${partitionDir}`;
  const absDir = safeJoin(storageDir, relDir);
  if (!absDir) throw new Error('the derived table path cannot be placed safely');
  await mkdir(absDir, { recursive: true });

  // Rows are keyed by our normalized column names before they are written, so
  // the NDJSON and the manifest agree and `read_ndjson` needs no mapping.
  const names = manifest.columns.map((c) => c.name);
  const lines = table.rows
    .map((row) => {
      const record: Record<string, unknown> = {};
      names.forEach((name, i) => {
        record[name] = row[i] ?? null;
      });
      return JSON.stringify(record);
    })
    .join('\n');

  const ndjsonPath = join(absDir, 'rows.ndjson.tmp');
  const target = join(absDir, partName('part', 0, 'parquet'));
  const tmp = `${target}.tmp`;
  await rm(tmp, { force: true });
  await writeFile(ndjsonPath, lines ? `${lines}\n` : '', 'utf8');

  try {
    await duck.runTrusted(
      `COPY (
         SELECT * FROM read_ndjson('${sqlLiteral(ndjsonPath)}', columns = ${columnsStruct(manifest)})
       ) TO '${sqlLiteral(tmp)}' (FORMAT parquet, COMPRESSION zstd);`,
      { allowedDirectories: [absDir], timeoutMs: MATERIALIZE_TIMEOUT_MS },
    );
    const counted = await duck.runTrusted<{ n: number }>(
      `SELECT count(*) AS n FROM read_parquet('${sqlLiteral(tmp)}')`,
      { allowedDirectories: [absDir], timeoutMs: MATERIALIZE_TIMEOUT_MS },
    );
    const rows = Number(counted[0]?.n ?? 0);
    if (rows !== table.rows.length) {
      throw new Error(
        `row count mismatch: ${table.rows.length} extracted, ${rows} written — output discarded`,
      );
    }
    await rename(tmp, target);

    await writeTableManifest(storageDir, corpusDir, manifest);
    const state = await readTableState(storageDir, corpusDir, manifest.table);
    await writeTableState(storageDir, corpusDir, manifest.table, {
      ...state,
      totalRows: rows,
      lastWriteAt: nowIso(),
      nextPart: 1,
    });
    return rows;
  } finally {
    // The NDJSON is scaffolding, not a landing buffer: a workbook table is a
    // snapshot, so there is nothing to append to later.
    await rm(ndjsonPath, { force: true }).catch(() => {});
    await rm(tmp, { force: true }).catch(() => {});
  }
}

/** Where the shadow markdown for a workbook lives, for the drain's card. */
export function workbookShadowDir(relPath: string): string {
  return dirname(relPath);
}
