/**
 * `azure-monitor-logs` — a native observation adapter over Azure Monitor's
 * Log Analytics query API.
 *
 * ── Why this is native rather than a `script` manifest ────────────────────
 *
 * The generic drivers can already fetch JSON and land rows, so a native
 * adapter has to earn itself. This one does, for one reason: **Azure returns
 * a typed column list with every result.** A response carries
 * `columns: [{ name, type }]` in Kusto's type vocabulary, which means the
 * table's schema is *known from the source* rather than guessed from a
 * sample. That turns an inferred manifest — the honest-but-thin thing a
 * generic endpoint gets — into an authored-quality one, with real types a
 * model can rely on when it writes a comparison.
 *
 * Two lesser reasons follow from the same shape: a single query can return
 * several tables (hence `ConnectorRecord.batches` being plural), and the
 * response is column-oriented (`rows` are positional arrays), which no
 * `rowMap` of JSON paths can express.
 *
 * ── Paging without a cursor ───────────────────────────────────────────────
 *
 * Log Analytics has no continuation token. Paging is done over **time**: each
 * pass asks for rows strictly newer than the last watermark, oldest-first, and
 * takes a bounded page. The watermark is the newest `TimeGenerated` actually
 * written, so a pass that fails leaves it where it was and the same window is
 * re-read rather than skipped.
 *
 * The strictness is deliberate and it is a trade. `>` (not `>=`) can drop a
 * row that shares a timestamp to the tick with the last row of the previous
 * page; `>=` would instead re-deliver that row on every pass forever. Ties at
 * 100-nanosecond resolution are rare, unbounded duplication is not, so the
 * adapter takes the strict comparison and notes it here rather than pretending
 * the problem does not exist.
 */

import { createLogger } from '@bendyline/gezel';
import type { ObservationColumn, ObservationColumnType } from '@bendyline/gezel';
import { connectorSecretKey } from '../registry.js';
import { registerNativeAdapter } from '../registry.js';
import type {
  AdapterDeps,
  ChangeBatch,
  ConnectorAdapter,
  ConnectorBindingRef,
  ConnectorRecord,
  ObservationBatch,
  RecordRef,
} from '../types.js';

const log = createLogger('connectors');

export const AZURE_MONITOR_LOGS_ADAPTER_ID = 'azure-monitor-logs';

/** Public cloud default; sovereign clouds override it via config. */
const DEFAULT_API_BASE = 'https://api.loganalytics.io';

/** Rows requested per pass. Azure's own ceiling is far higher; this bounds us. */
const DEFAULT_PAGE_ROWS = 10_000;
const MAX_PAGE_ROWS = 50_000;

/** Pages one sync pass will walk before yielding to the next tick. */
const MAX_PAGES_PER_PASS = 20;

export interface AzureMonitorLogsConfig {
  /** Log Analytics workspace GUID. */
  workspaceId: string;
  /** KQL table to read, e.g. `AzureDiagnostics` or `AppRequests`. */
  kqlTable: string;
  /** Optional KQL appended after the table, e.g. `| where ResultType != "Success"`. */
  filter?: string;
  /** Destination table slug in the corpus. Defaults to a slug of `kqlTable`. */
  table?: string;
  /** Column carrying the row timestamp. Azure's convention is TimeGenerated. */
  timeColumn: string;
  /** How far back a first sync reaches. */
  backfillDays: number;
  pageRows: number;
  apiBaseUrl: string;
}

export interface AzureMonitorLogsRuntime {
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
}

const defaultRuntime: AzureMonitorLogsRuntime = {
  fetch: (input, init) => fetch(input, init),
};

/** Azure's response envelope. `rows` are positional against `columns`. */
interface KustoTable {
  name: string;
  columns: { name: string; type: string }[];
  rows: unknown[][];
}
interface KustoResponse {
  tables?: KustoTable[];
  error?: { message?: string; code?: string };
}

interface AzureCursor {
  /** Newest row timestamp successfully written, ISO 8601. */
  watermark?: string;
}

export function parseConfig(raw: unknown): AzureMonitorLogsConfig {
  const cfg = (raw ?? {}) as Record<string, unknown>;
  const workspaceId = String(cfg.workspaceId ?? '').trim();
  if (!workspaceId) throw new Error('Azure Monitor: a workspace ID is required.');
  const kqlTable = String(cfg.kqlTable ?? '').trim();
  if (!kqlTable) throw new Error('Azure Monitor: a KQL table name is required.');
  // The table name is interpolated into a query, so it is constrained to a
  // Kusto identifier rather than trusted. A filter clause is deliberately NOT
  // constrained — it is arbitrary KQL by design — but it is only ever supplied
  // by the user in their own workspace, and the credential is scoped to it.
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(kqlTable)) {
    throw new Error(`Azure Monitor: '${kqlTable}' is not a valid table name.`);
  }
  const timeColumn = String(cfg.timeColumn ?? 'TimeGenerated').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(timeColumn)) {
    throw new Error(`Azure Monitor: '${timeColumn}' is not a valid column name.`);
  }

  const apiBaseUrl = String(cfg.apiBaseUrl ?? DEFAULT_API_BASE)
    .trim()
    .replace(/\/+$/, '');
  let base: URL;
  try {
    base = new URL(apiBaseUrl);
  } catch {
    throw new Error('Azure Monitor: the API base URL must be absolute.');
  }
  if (base.protocol !== 'https:') {
    // A workspace token is a bearer credential; plaintext transport would put
    // it on the wire.
    throw new Error('Azure Monitor: the API base URL must use HTTPS.');
  }

  const backfillDaysRaw = Number(cfg.backfillDays ?? 7);
  const pageRowsRaw = Number(cfg.pageRows ?? DEFAULT_PAGE_ROWS);
  return {
    workspaceId,
    kqlTable,
    ...(typeof cfg.filter === 'string' && cfg.filter.trim() ? { filter: cfg.filter.trim() } : {}),
    ...(typeof cfg.table === 'string' && cfg.table.trim() ? { table: cfg.table.trim() } : {}),
    timeColumn,
    backfillDays: Number.isFinite(backfillDaysRaw)
      ? Math.max(1, Math.min(backfillDaysRaw, 365))
      : 7,
    pageRows: Number.isFinite(pageRowsRaw)
      ? Math.max(100, Math.min(pageRowsRaw, MAX_PAGE_ROWS))
      : DEFAULT_PAGE_ROWS,
    apiBaseUrl,
  };
}

/**
 * Kusto's type vocabulary → ours.
 *
 * `dynamic` becomes JSON rather than VARCHAR because it really is structured;
 * keeping it queryable as JSON is the difference between being able to reach
 * into a nested property and having to string-match it.
 */
export function kustoTypeToColumnType(kusto: string): ObservationColumnType {
  switch (kusto.toLowerCase()) {
    case 'datetime':
      return 'TIMESTAMP';
    case 'bool':
    case 'boolean':
      return 'BOOLEAN';
    case 'int':
    case 'long':
      return 'BIGINT';
    case 'real':
    case 'double':
    case 'decimal':
      return 'DOUBLE';
    case 'dynamic':
      return 'JSON';
    default:
      // string, guid, timespan, and anything Azure adds later. A timespan is
      // deliberately text: Kusto renders it as `d.hh:mm:ss`, which no numeric
      // type round-trips.
      return 'VARCHAR';
  }
}

/** Lowercase snake_case, matching the writer's own column normalization. */
export function toColumnName(raw: string): string {
  const snake = raw
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
    .slice(0, 120);
  if (!snake) return 'col';
  return /^[a-z_]/.test(snake) ? snake : `c_${snake}`;
}

/** Derive our column list from Azure's own typed column list. */
export function columnsFromKusto(
  table: KustoTable,
  timeColumn: string,
  partitionColumn: string,
): ObservationColumn[] {
  const timeName = toColumnName(timeColumn);
  const columns: ObservationColumn[] = table.columns.map((column) => {
    const name = toColumnName(column.name);
    const type = kustoTypeToColumnType(column.type);
    const role: ObservationColumn['role'] =
      name === timeName
        ? 'time'
        : type === 'BIGINT' || type === 'DOUBLE'
          ? 'measure'
          : type === 'JSON'
            ? 'attribute'
            : 'dimension';
    return {
      name,
      type,
      role,
      ...(name !== column.name ? { description: `Azure column \`${column.name}\`.` } : {}),
    };
  });
  // The partition column is synthesized by the writer, so it is not in
  // Azure's list — but it must be declared or the compactor will not carry it.
  if (!columns.some((c) => c.name === partitionColumn)) {
    columns.push({
      name: partitionColumn,
      type: 'VARCHAR',
      role: 'dimension',
      description: 'Day bucket derived from the row timestamp; filter on it to skip whole files.',
    });
  }
  return columns;
}

function asCursor(raw: unknown): AzureCursor {
  const watermark = (raw as AzureCursor | undefined)?.watermark;
  return typeof watermark === 'string' && watermark ? { watermark } : {};
}

export class AzureMonitorLogsAdapter implements ConnectorAdapter<ConnectorRecord, AzureCursor> {
  readonly typeId = AZURE_MONITOR_LOGS_ADAPTER_ID;
  private config?: AzureMonitorLogsConfig;
  private token = '';
  /** Rows fetched per page index, so `fetchRecord` needs no second request. */
  private readonly pages = new Map<string, { table: KustoTable; destination: string }>();
  private pageSeq = 0;

  constructor(
    private readonly binding: ConnectorBindingRef,
    private readonly deps: AdapterDeps,
    private readonly runtime: AzureMonitorLogsRuntime = defaultRuntime,
  ) {}

  async ensureAuth(): Promise<void> {
    this.config = parseConfig(this.binding.config);
    const token = (
      await this.deps.secrets.get(connectorSecretKey(this.binding.type, this.binding.id))
    )?.trim();
    if (!token) {
      throw new Error(
        'Azure Monitor: no access token is configured for this connection. Add one in the project’s Connections tab.',
      );
    }
    this.token = token;
  }

  async listScopes(): Promise<string[]> {
    return [''];
  }

  async listChangesSince(
    _scope: string,
    cursor: AzureCursor | undefined,
  ): Promise<ChangeBatch<AzureCursor>> {
    const config = this.config;
    if (!config) throw new Error('Azure Monitor: ensureAuth was not called');
    const { watermark } = asCursor(cursor);

    const since =
      watermark ?? new Date(Date.now() - config.backfillDays * 86_400_000).toISOString();

    let response: KustoResponse;
    try {
      response = await this.query(config, since);
    } catch (err) {
      if (err instanceof AzureThrottledError) {
        // Surfaced as a signal, not an exception: the engine's own backoff
        // ladder then paces the binding, and the cursor stays put so the same
        // window is re-read rather than skipped.
        return { records: [], cursor: watermark ? { watermark } : {}, rateLimited: true };
      }
      throw err;
    }
    const tables = (response.tables ?? []).filter((t) => t.rows.length > 0);
    if (tables.length === 0) {
      // Nothing new. Hold the watermark: advancing it past a window we never
      // read would skip rows that arrive late.
      return { records: [], cursor: watermark ? { watermark } : {} };
    }

    const pageIndex = this.pageSeq++;
    const id = `page-${pageIndex}`;
    // One ref per page — the engine's backfill cap counts refs, and a page
    // here is thousands of rows.
    this.pages.set(id, {
      table: tables[0] as KustoTable,
      destination: config.table ?? toColumnName(config.kqlTable),
    });
    for (const [i, extra] of tables.slice(1).entries()) {
      this.pages.set(`${id}:${i}`, { table: extra, destination: toColumnName(extra.name) });
    }

    const newest = this.newestTimestamp(tables, config.timeColumn);
    if (!newest) {
      // Rows came back but none carried a usable timestamp, so the watermark
      // cannot advance — and a cursor that never advances re-reads the same
      // window forever. That is a misconfigured `timeColumn`, and saying so
      // is far better than syncing in a silent loop.
      throw new Error(
        `Azure Monitor: no usable '${config.timeColumn}' value in the results, so the sync cannot advance. Check the time column against the table you are querying.`,
      );
    }
    // `partial` when the page came back full: there is very likely more in
    // this window, so the engine continues the scope this tick.
    const full = tables.some((t) => t.rows.length >= config.pageRows);
    return {
      records: [{ id, ordinalKey: pageIndex }],
      cursor: { watermark: newest },
      ...(full && pageIndex < MAX_PAGES_PER_PASS ? { partial: true } : {}),
    };
  }

  async fetchRecord(_scope: string, ref: RecordRef): Promise<ConnectorRecord> {
    const config = this.config;
    if (!config) throw new Error('Azure Monitor: ensureAuth was not called');

    const batches: ObservationBatch[] = [];
    for (const [key, page] of this.pages) {
      if (key !== ref.id && !key.startsWith(`${ref.id}:`)) continue;
      batches.push(this.toBatch(page.table, page.destination, config));
      this.pages.delete(key);
    }
    return { kind: 'observations', batches };
  }

  async close(): Promise<void> {
    this.pages.clear();
  }

  /** Column-oriented Azure rows → our row objects. */
  private toBatch(
    table: KustoTable,
    destination: string,
    config: AzureMonitorLogsConfig,
  ): ObservationBatch {
    const names = table.columns.map((c) => toColumnName(c.name));
    const types = table.columns.map((c) => kustoTypeToColumnType(c.type));
    const rows = table.rows.map((values) => {
      const row: Record<string, unknown> = {};
      for (const [i, name] of names.entries()) {
        const value = values[i];
        // `dynamic` arrives already parsed by some API versions and as a JSON
        // string in others; normalize to text so the writer's JSON column
        // stores one shape.
        row[name] =
          types[i] === 'JSON' && value !== null && typeof value === 'object'
            ? JSON.stringify(value)
            : value;
      }
      return row;
    });
    return { table: destination, rows };
  }

  private newestTimestamp(tables: KustoTable[], timeColumn: string): string | undefined {
    const wanted = toColumnName(timeColumn);
    let newest: string | undefined;
    for (const table of tables) {
      const index = table.columns.findIndex((c) => toColumnName(c.name) === wanted);
      if (index < 0) continue;
      for (const row of table.rows) {
        const value = row[index];
        if (typeof value === 'string' && (newest === undefined || value > newest)) newest = value;
      }
    }
    return newest;
  }

  private async query(config: AzureMonitorLogsConfig, since: string): Promise<KustoResponse> {
    // Oldest-first with a bounded take is what makes time-paging deterministic:
    // each pass consumes the front of the window and the watermark advances by
    // exactly what was read.
    const kql = [
      config.kqlTable,
      `| where ${config.timeColumn} > datetime(${escapeKqlDatetime(since)})`,
      config.filter ?? '',
      `| sort by ${config.timeColumn} asc`,
      `| take ${config.pageRows}`,
    ]
      .filter(Boolean)
      .join('\n');

    const url = `${config.apiBaseUrl}/v1/workspaces/${encodeURIComponent(config.workspaceId)}/query`;
    const response = await this.runtime.fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ query: kql }),
    });

    if (response.status === 429 || response.status === 503) {
      // Reported, not thrown: a throw voids the batch and re-reads the same
      // window next tick, which is how a throttled API gets hammered.
      const retryAfter = response.headers.get('retry-after');
      log.info(`azure-monitor-logs throttled${retryAfter ? ` (retry-after ${retryAfter})` : ''}`);
      throw new AzureThrottledError('Azure Monitor throttled the query');
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `Azure Monitor query failed (${response.status}): ${body.slice(0, 240) || response.statusText}`,
      );
    }
    const parsed = (await response.json()) as KustoResponse;
    if (parsed.error) {
      throw new Error(
        `Azure Monitor rejected the query: ${parsed.error.message ?? 'unknown error'}`,
      );
    }
    return parsed;
  }
}

/** Marks a throttle so the sync engine backs the binding off rather than failing it. */
export class AzureThrottledError extends Error {
  readonly rateLimited = true as const;
  constructor(message: string) {
    super(message);
    this.name = 'AzureThrottledError';
  }
}

/** ISO 8601 with the quoting Kusto's `datetime()` literal needs. */
export function escapeKqlDatetime(iso: string): string {
  // Constrained rather than escaped: a datetime literal has one legal shape,
  // and anything else is a bug or an injection attempt, not a value to quote.
  if (!/^\d{4}-\d{2}-\d{2}T[\d:.]+Z?$/.test(iso)) {
    throw new Error(`Azure Monitor: refusing to build a query from a non-ISO timestamp: ${iso}`);
  }
  return iso;
}

export function registerAzureMonitorLogsAdapters(): void {
  registerNativeAdapter(AZURE_MONITOR_LOGS_ADAPTER_ID, async (binding, deps) =>
    Promise.resolve(new AzureMonitorLogsAdapter(binding, deps)),
  );
}

export { columnsFromKusto as azureColumnsFromKusto };
