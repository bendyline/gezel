/**
 * The read side of an observation corpus: what tables a project has, what
 * each one means, and how a question becomes rows.
 *
 * The whole point of this layer is that **the model never sees a row of the
 * corpus** — it sees a schema and then an answer. A document corpus makes the
 * gezel read files, so corpus size and context size are the same number and
 * 20,000 records is a ceiling. Here the gezel writes SQL and reads a small
 * result set, which is what lets the corpus be arbitrarily larger than the
 * context window.
 *
 * Three things this module owns:
 *
 * - **Discovery.** Which of a project's connector bindings hold tables, and
 *   what to call them when two bindings both have a `requests`.
 * - **Views.** Physical layout (Hive partitions of Parquet, plus NDJSON that
 *   has not been compacted yet) is not something a model should have to know.
 *   Each table becomes one view named after the table, so a query reads
 *   `FROM requests` and freshly-synced rows are visible immediately.
 * - **Execution.** Guard, then run under the lockdown, then cap.
 */

import { createLogger, type ObservationTableManifest } from '@bendyline/gezel';
import type { Store } from '../fs/store.js';
import { corpusDirFor } from '../connectors/manager.js';
import { DEFAULT_DUCK_TIMEOUT_MS, type DuckRunner, sqlLiteral } from './duck.js';
import {
  type ObservationTableState,
  listPartitionFiles,
  listPartitions,
  listTables,
  partitionValueFromDir,
  readTableManifest,
  readTableState,
  tableRelDir,
} from './layout.js';
import { assertReadOnlyStatement } from './statement-guard.js';
import {
  listWorkspaceCorpusDirs,
  sourceRelPathFromCorpusDir,
} from './workspace-tables.js';
import { resolveInside } from '../fs/safe-paths.js';

const log = createLogger('observations');

/** Rows returned when the caller names no limit. */
export const DEFAULT_ROW_LIMIT = 100;
/** Ceiling on rows returned in one call, whatever the caller asks for. */
export const MAX_ROW_LIMIT = 10_000;

export interface ObservationTableRef {
  /**
   * Where this table came from. A connector table is a mirror of an external
   * system; a workspace table is derived from a file sitting in the project.
   * The distinction matters to a reader: "which spreadsheet is this?" is a
   * question only the second kind can answer.
   */
  source: 'connector' | 'workspace';
  /** Connector binding that owns this table; absent for a workspace table. */
  bindingId?: string;
  /**
   * What to call the source in prose. The binding's display name for a
   * connector, the workspace-relative file path for a workspace table —
   * which is the thing a user will actually ask about.
   */
  sourceLabel: string;
  /** Artifact-relative corpus root. */
  corpusDir: string;
  /** Table slug inside the corpus. */
  table: string;
  /** The name a query uses. Equal to `table` unless two corpora collide. */
  queryName: string;
  manifest: ObservationTableManifest;
  state: ObservationTableState;
  /** Partition values present, newest first. */
  partitions: string[];
}

export interface ObservationQueryDeps {
  store: Store;
  duck: DuckRunner;
}

/** Minimal project shape this module needs. */
interface ProjectLike {
  id: string;
  connectors?: { id: string; type: string; displayName?: string; corpusDir?: string }[];
}

/**
 * Every observation table in a project.
 *
 * A corpus is identified as tabular by having a `tables/` directory with
 * content, not by re-resolving its connector-type manifest from the catalog.
 * The corpus on disk is the thing being queried, and a catalog lookup would
 * make a query fail for a binding whose type was uninstalled — exactly when
 * the mirrored data is the only copy left.
 */
async function collectTablesIn(
  storageDir: string,
  corpusDir: string,
  origin: Pick<ObservationTableRef, 'source' | 'sourceLabel'> & { bindingId?: string },
): Promise<Omit<ObservationTableRef, 'queryName'>[]> {
  const found: Omit<ObservationTableRef, 'queryName'>[] = [];
  for (const table of await listTables(storageDir, corpusDir)) {
    const manifest = await readTableManifest(storageDir, corpusDir, table);
    if (!manifest) {
      log.warn(`table '${table}' in ${corpusDir} has no readable manifest; skipping`);
      continue;
    }
    found.push({
      ...origin,
      corpusDir,
      table,
      manifest,
      state: await readTableState(storageDir, corpusDir, table),
      partitions: (await listPartitions(storageDir, corpusDir, table))
        .map((d) => partitionValueFromDir(d)?.value ?? d)
        .filter(Boolean),
    });
  }
  return found;
}

export async function listProjectTables(
  store: Store,
  project: ProjectLike,
): Promise<ObservationTableRef[]> {
  const bindings = project.connectors ?? [];
  const storageDir = store.projectArtifactsDir(project.id);

  const found: Omit<ObservationTableRef, 'queryName'>[] = [];
  for (const binding of bindings) {
    const corpusDir = corpusDirFor(bindings as never, binding as never);
    found.push(
      ...(await collectTablesIn(storageDir, corpusDir, {
        source: 'connector',
        bindingId: binding.id,
        sourceLabel: binding.displayName ?? binding.type,
      })),
    );
  }

  // Tables derived from files already in the workspace. Deliberately not gated
  // on there being any connector: a project can hold nothing but spreadsheets.
  for (const corpusDir of await listWorkspaceCorpusDirs(storageDir)) {
    found.push(
      ...(await collectTablesIn(storageDir, corpusDir, {
        source: 'workspace',
        sourceLabel: sourceRelPathFromCorpusDir(corpusDir) ?? corpusDir,
      })),
    );
  }

  // Two bindings can each hold a `requests`. Only the colliding ones get
  // qualified, so the common case stays the short, obvious name.
  const counts = new Map<string, number>();
  for (const entry of found) counts.set(entry.table, (counts.get(entry.table) ?? 0) + 1);

  return found.map((entry) => ({
    ...entry,
    queryName:
      (counts.get(entry.table) ?? 0) > 1
        ? `${entry.corpusDir.split('/').pop()}_${entry.table}`.replace(/[^a-z0-9_]+/gi, '_')
        : entry.table,
  }));
}

/**
 * Cheap existence probe: does this project hold any observation table?
 *
 * Used to decide whether a session's MCP bridge registers the table tools at
 * all. The tool listing is injected into every system prompt, so three tools
 * a project can never use are pure prompt cost at depth — the same reasoning
 * that gates the mail and social write tools. Stops at the first table found
 * and reads no manifests, so it stays a directory probe rather than a scan.
 */
export async function hasObservationTables(
  store: Store,
  project: ProjectLike,
): Promise<boolean> {
  const bindings = project.connectors ?? [];
  const storageDir = store.projectArtifactsDir(project.id);
  for (const binding of bindings) {
    const corpusDir = corpusDirFor(bindings as never, binding as never);
    if ((await listTables(storageDir, corpusDir)).length > 0) return true;
  }
  for (const corpusDir of await listWorkspaceCorpusDirs(storageDir)) {
    if ((await listTables(storageDir, corpusDir)).length > 0) return true;
  }
  return false;
}

/** Resolve one table by the name a caller used, tolerantly. */
export function findTable(
  tables: readonly ObservationTableRef[],
  name: string,
): ObservationTableRef | null {
  const wanted = name.trim().toLowerCase();
  return (
    tables.find((t) => t.queryName.toLowerCase() === wanted) ??
    tables.find((t) => t.table.toLowerCase() === wanted) ??
    null
  );
}

/**
 * SQL defining one table's view, or null when the table has no data files at
 * all.
 *
 * Parquet and not-yet-compacted NDJSON are unioned by name so a question about
 * data synced two minutes ago is answerable before the night shift has
 * compacted it. A table with no files yet still gets a **typed empty view**
 * built from its manifest, because "no rows" is a real answer and an
 * `IO Error: No files found` is not one a model can act on.
 */
export async function buildTableView(
  storageDir: string,
  ref: ObservationTableRef,
): Promise<string> {
  const sources: string[] = [];
  const parquet: string[] = [];
  const ndjson: string[] = [];

  for (const partitionDir of await listPartitions(storageDir, ref.corpusDir, ref.table)) {
    const files = await listPartitionFiles(storageDir, ref.corpusDir, ref.table, partitionDir);
    parquet.push(...files.parquet);
    // Sealed and open alike: an open part is still complete NDJSON up to its
    // last newline, and excluding it would make a just-finished sync invisible.
    ndjson.push(...files.sealed, ...files.open);
  }

  if (parquet.length > 0) {
    const list = parquet.map((f) => `'${sqlLiteral(f)}'`).join(', ');
    sources.push(`SELECT * FROM read_parquet([${list}], union_by_name = true)`);
  }
  if (ndjson.length > 0) {
    const list = ndjson.map((f) => `'${sqlLiteral(f)}'`).join(', ');
    const columns = ref.manifest.columns
      .map((c) => `'${sqlLiteral(c.name)}': '${c.type}'`)
      .join(', ');
    sources.push(`SELECT * FROM read_ndjson([${list}], columns = {${columns}})`);
  }

  const body =
    sources.length > 0
      ? sources.join('\n      UNION ALL BY NAME\n      ')
      : `SELECT ${ref.manifest.columns
          .map((c) => `NULL::${c.type} AS "${c.name}"`)
          .join(', ')} WHERE false`;

  return `CREATE OR REPLACE VIEW "${ref.queryName}" AS ${body};`;
}

export interface QueryResult {
  rows: Record<string, unknown>[];
  /** Columns in result order, even when zero rows came back. */
  columns: string[];
  /** More rows matched than were returned. */
  truncated: boolean;
  /** The limit actually applied. */
  limit: number;
  /** Tables whose views were in scope. */
  tablesInScope: string[];
}

export interface RunQueryOptions {
  sql: string;
  limit?: number;
  /** Restrict the views built; default is every table in the project. */
  tables?: readonly string[];
  timeoutMs?: number;
}

/**
 * Guard, then run.
 *
 * The statement is validated by `assertReadOnlyStatement` *before* the views
 * are assembled around it, so an attempt to smuggle a second statement is
 * refused rather than being wrapped and executed — the wrapper below is a
 * row-cap, never a security boundary.
 */
export async function runQuery(
  deps: ObservationQueryDeps,
  project: ProjectLike,
  opts: RunQueryOptions,
): Promise<QueryResult> {
  const storageDir = deps.store.projectArtifactsDir(project.id);
  const all = await listProjectTables(deps.store, project);
  if (all.length === 0) {
    throw new NoTablesError(
      'this project has no data tables yet. They appear when a data connector is bound and synced, ' +
        'or when a spreadsheet or large data file in the workspace has been indexed.',
    );
  }

  const scope = opts.tables?.length
    ? all.filter((t) => opts.tables?.some((n) => n.toLowerCase() === t.queryName.toLowerCase()))
    : all;
  if (scope.length === 0) {
    throw new NoTablesError(
      `no table matched ${JSON.stringify(opts.tables)}; available: ${all.map((t) => t.queryName).join(', ')}`,
    );
  }

  const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_ROW_LIMIT, MAX_ROW_LIMIT));
  const allowedDirectories = [
    ...new Set(
      await Promise.all(
        scope.map((t) => resolveInside(storageDir, tableRelDir(t.corpusDir, t.table))),
      ),
    ),
  ];

  const statement = await assertReadOnlyStatement(opts.sql, deps.duck, {
    allowedDirectories,
    timeoutMs: opts.timeoutMs ?? DEFAULT_DUCK_TIMEOUT_MS,
  });

  const views = await Promise.all(scope.map((t) => buildTableView(storageDir, t)));
  // One extra row is requested so "there were more" is a fact rather than a
  // guess from `rows.length === limit`.
  const script = `${views.join('\n')}\nSELECT * FROM (\n${statement}\n) LIMIT ${limit + 1};`;

  const rows = await deps.duck.runTrusted<Record<string, unknown>>(script, {
    allowedDirectories,
    timeoutMs: opts.timeoutMs ?? DEFAULT_DUCK_TIMEOUT_MS,
  });

  const truncated = rows.length > limit;
  const kept = truncated ? rows.slice(0, limit) : rows;
  return {
    rows: kept,
    columns: kept.length > 0 ? Object.keys(kept[0] as Record<string, unknown>) : [],
    truncated,
    limit,
    tablesInScope: scope.map((t) => t.queryName),
  };
}

export class NoTablesError extends Error {
  readonly code = 'no-observation-tables' as const;
  readonly isActionable = true;
  constructor(message: string) {
    super(message);
    this.name = 'NoTablesError';
  }
}

/**
 * Render a table's semantic layer for a model.
 *
 * This is the grounding step, and it is why the corpus is worth querying at
 * all: a model handed bare column names writes confident, wrong SQL, while
 * one handed units, roles, cardinality and a worked example writes SQL that
 * answers the question. Ordering is deliberate — identity, then how to filter
 * it cheaply, then columns, then examples last so they sit nearest the
 * model's own output.
 */
export function renderTableDescription(ref: ObservationTableRef): string {
  const m = ref.manifest;
  const lines: string[] = [];

  lines.push(`# ${m.title ?? ref.queryName}`);
  lines.push('');
  lines.push(
    ref.source === 'workspace'
      ? `Query it as \`${ref.queryName}\`. Built from the file \`${ref.sourceLabel}\` in this project.`
      : `Query it as \`${ref.queryName}\`. Mirrored from ${ref.sourceLabel}.`,
  );
  if (m.description) lines.push('', m.description);
  if (m.grain) lines.push('', `**One row is:** ${m.grain}`);

  const rows = ref.state.totalRows;
  const span =
    ref.partitions.length > 0
      ? `${ref.partitions[ref.partitions.length - 1]} → ${ref.partitions[0]}`
      : 'no data yet';
  lines.push('', `**Rows:** ${rows.toLocaleString('en-US')} · **Partitions:** ${span}`);

  if (m.partitionColumn) {
    lines.push(
      '',
      `**Filter on \`${m.partitionColumn}\` whenever you can.** It is the physical partition, ` +
        'so a query that constrains it skips whole files instead of scanning them.',
    );
  }
  if (m.inferred) {
    lines.push(
      '',
      '> This schema was inferred from the data rather than authored, so the column types are ' +
        'a best guess from a sample. Cast explicitly if a comparison behaves oddly.',
    );
  }

  lines.push('', '## Columns', '');
  lines.push('| Column | Type | Role | Notes |');
  lines.push('| --- | --- | --- | --- |');
  for (const c of m.columns) {
    const notes = [
      c.description,
      c.unit ? `unit: ${c.unit}` : null,
      c.cardinalityHint ? `cardinality: ${c.cardinalityHint}` : null,
      c.examples?.length ? `e.g. ${c.examples.map((e) => `\`${e}\``).join(', ')}` : null,
    ]
      .filter(Boolean)
      .join('; ');
    lines.push(`| \`${c.name}\` | ${c.type} | ${c.role} | ${notes} |`);
  }

  if (m.measures.length > 0) {
    lines.push('', '## Measures', '');
    for (const measure of m.measures) {
      const unit = measure.unit ? ` (${measure.unit})` : '';
      lines.push(
        `- **${measure.name}**${unit} — \`${measure.sql}\`${
          measure.description ? ` — ${measure.description}` : ''
        }`,
      );
    }
  }

  if (m.exemplars.length > 0) {
    lines.push('', '## Example queries', '');
    for (const ex of m.exemplars) {
      lines.push(`**${ex.question}**`, '', '```sql', ex.sql, '```', '');
    }
  }

  return lines.join('\n');
}

/** One line per table, for the listing tool. */
export function summarizeTable(ref: ObservationTableRef): {
  table: string;
  title?: string;
  grain?: string;
  rows: number;
  columns: number;
  partitions: number;
  earliestPartition?: string;
  latestPartition?: string;
  origin: 'connector' | 'workspace';
  source: string;
  schemaInferred: boolean;
} {
  return {
    table: ref.queryName,
    ...(ref.manifest.title ? { title: ref.manifest.title } : {}),
    ...(ref.manifest.grain ? { grain: ref.manifest.grain } : {}),
    rows: ref.state.totalRows,
    columns: ref.manifest.columns.length,
    partitions: ref.partitions.length,
    ...(ref.partitions.length > 0
      ? {
          earliestPartition: ref.partitions[ref.partitions.length - 1] as string,
          latestPartition: ref.partitions[0] as string,
        }
      : {}),
    origin: ref.source,
    source: ref.sourceLabel,
    schemaInferred: ref.manifest.inferred === true,
  };
}
