/**
 * `ObservationWriter` — where rows land.
 *
 * The document corpus's writer turns one record into one markdown file. This
 * is its counterpart for the tabular shape, and the differences are all
 * consequences of one fact: nobody reads an individual row.
 *
 * - **Append-only NDJSON, then Parquet.** Rows land as newline-delimited JSON
 *   parts and a later compaction pass converts sealed parts to Parquet with
 *   the bundled DuckDB CLI. That ordering means gezel needs no Parquet
 *   encoder in Node at all, gives crash-safety for free (a torn append loses
 *   at most a trailing line, which the compactor's row-count check catches),
 *   and keeps freshly-synced data greppable while it waits.
 * - **No content scanner.** The document writer scans every body and can
 *   quarantine it, because that text goes into a prompt. A row never does —
 *   the model sees query *results*, rendered and capped by the tool layer —
 *   and scanning per row at these volumes would be ruinous.
 * - **Coerce to the declared schema on the way in.** Unknown keys are dropped
 *   and missing ones written as null, so every part of a table has the same
 *   columns. Letting each part carry whatever the source happened to send is
 *   how a table becomes unreadable one file at a time.
 *
 * The writer is constructed per sync pass, holds one append stream per
 * (table, partition), and must have {@link ObservationWriter.finish} awaited —
 * that is what seals the open parts and flushes state.
 */

import { createWriteStream, existsSync, type WriteStream } from 'node:fs';
import { mkdir, rename, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createLogger, nowIso, type ObservationTableManifest } from '@bendyline/gezel';
import { resolveInside } from '../fs/safe-paths.js';
import { slug } from '../connectors/writer.js';
import type { ObservationBatch } from '../connectors/types.js';
import {
  type ObservationTableState,
  UNPARTITIONED,
  partName,
  partitionDirName,
  readTableManifest,
  readTableState,
  tableRelDir,
  writeTableManifest,
  writeTableState,
} from './layout.js';
import { INFERENCE_SAMPLE_ROWS, inferTableManifest, safeColumnName } from './schema-inference.js';

const log = createLogger('observations');

/** Seal an open part once it passes this size. Parquet likes large inputs. */
export const PART_TARGET_BYTES = 64 * 1024 * 1024;

/** Default partition column when a table declares none but has a time column. */
export const DEFAULT_PARTITION_COLUMN = 'dt';

export interface ObservationWriterOptions {
  /** Project artifacts root. */
  storageDir: string;
  /** Artifact-relative corpus root (`data/<corpus>`). */
  corpusDir: string;
  /**
   * Authored manifests from the connector type, keyed by table. A table absent
   * here (and absent on disk) gets an inferred manifest once rows arrive.
   */
  manifests?: Map<string, ObservationTableManifest>;
  /** Seal threshold override, for tests. */
  partTargetBytes?: number;
}

export interface ObservationTableSummary {
  table: string;
  rowsWritten: number;
  partitions: string[];
  /** Absolute paths of parts sealed by this pass, ready for compaction. */
  sealedParts: string[];
  manifestInferred: boolean;
}

export interface ObservationWriteSummary {
  rowsWritten: number;
  tables: ObservationTableSummary[];
}

interface OpenPart {
  absPath: string;
  stream: WriteStream;
  bytes: number;
  ordinal: number;
}

interface TableRuntime {
  manifest: ObservationTableManifest;
  manifestInferred: boolean;
  /** Set when the manifest still needs to be written (inferred or new). */
  manifestDirty: boolean;
  state: ObservationTableState;
  /** Rows kept only until the schema is fixed, for inference. */
  inferenceSample: Record<string, unknown>[];
  rowsWritten: number;
  partitions: Set<string>;
  sealedParts: string[];
  open: Map<string, OpenPart>;
}

export class ObservationWriter {
  private readonly tables = new Map<string, TableRuntime>();
  private readonly partTargetBytes: number;

  constructor(private readonly opts: ObservationWriterOptions) {
    this.partTargetBytes = opts.partTargetBytes ?? PART_TARGET_BYTES;
  }

  /**
   * Append one page of rows. Shaped to the sync engine's injectable `write`
   * seam so the whole pass — scopes, cursor envelope, paging, retry,
   * rate-limit back-off — is the document path's code, unchanged.
   */
  async writeBatch(batch: ObservationBatch): Promise<{ rows: number }> {
    // Checked BEFORE anything lands. A source that told us how many rows it
    // was sending and then sent a different number has truncated the page;
    // writing the partial and then throwing would leave those rows in the
    // corpus while the cursor stays unadvanced, so the retry duplicates them.
    if (batch.expectedRows !== undefined && batch.expectedRows !== batch.rows.length) {
      throw new Error(
        `observation page for table '${slug(batch.table)}' declared ${batch.expectedRows} rows but carried ${batch.rows.length}`,
      );
    }

    const table = slug(batch.table);
    const rt = await this.runtimeFor(table, batch.rows);

    const partitionColumn = rt.manifest.partitionColumn ?? DEFAULT_PARTITION_COLUMN;
    const byPartition = new Map<string, string[]>();

    for (const raw of batch.rows) {
      const row = coerceRow(raw, rt.manifest);
      const partition = resolvePartition(batch.partition, raw, row, rt.manifest);
      if (rt.manifest.partitionColumn) row[partitionColumn] = partition;
      const lines = byPartition.get(partition) ?? [];
      lines.push(JSON.stringify(row));
      byPartition.set(partition, lines);
    }

    let rows = 0;
    for (const [partition, lines] of byPartition) {
      await this.appendLines(rt, table, partitionColumn, partition, lines);
      rt.partitions.add(partition);
      rows += lines.length;
    }

    rt.rowsWritten += rows;
    rt.state.totalRows += rows;
    rt.state.lastWriteAt = nowIso();
    return { rows };
  }

  /** Seal every open part and flush manifests + state. Always await this. */
  async finish(): Promise<ObservationWriteSummary> {
    const tables: ObservationTableSummary[] = [];
    let rowsWritten = 0;

    for (const [table, rt] of this.tables) {
      for (const partition of [...rt.open.keys()]) {
        await this.sealPart(rt, table, partition);
      }
      if (rt.manifestDirty) {
        // Inference sharpens as rows arrive, so re-derive from the sample the
        // pass actually saw before persisting.
        if (rt.manifestInferred && rt.inferenceSample.length > 0) {
          rt.manifest = inferTableManifest(rt.inferenceSample, {
            table,
            partitionColumn: rt.manifest.partitionColumn ?? DEFAULT_PARTITION_COLUMN,
            ...(rt.manifest.timeColumn ? { timeColumn: rt.manifest.timeColumn } : {}),
          });
        }
        await writeTableManifest(this.opts.storageDir, this.opts.corpusDir, rt.manifest);
      }
      await writeTableState(this.opts.storageDir, this.opts.corpusDir, table, rt.state);

      rowsWritten += rt.rowsWritten;
      tables.push({
        table,
        rowsWritten: rt.rowsWritten,
        partitions: [...rt.partitions].sort(),
        sealedParts: rt.sealedParts,
        manifestInferred: rt.manifestInferred,
      });
    }
    return { rowsWritten, tables };
  }

  private async runtimeFor(
    table: string,
    sampleRows: readonly Record<string, unknown>[],
  ): Promise<TableRuntime> {
    const existing = this.tables.get(table);
    if (existing) {
      if (existing.manifestInferred && existing.inferenceSample.length < INFERENCE_SAMPLE_ROWS) {
        existing.inferenceSample.push(
          ...sampleRows.slice(0, INFERENCE_SAMPLE_ROWS - existing.inferenceSample.length),
        );
      }
      return existing;
    }

    const authored = this.opts.manifests?.get(table);
    const onDisk = authored
      ? null
      : await readTableManifest(this.opts.storageDir, this.opts.corpusDir, table);
    const state = await readTableState(this.opts.storageDir, this.opts.corpusDir, table);

    let manifest = authored ?? onDisk;
    let inferred = false;
    if (!manifest) {
      inferred = true;
      manifest = inferTableManifest(sampleRows, {
        table,
        partitionColumn: DEFAULT_PARTITION_COLUMN,
      });
    }

    const rt: TableRuntime = {
      manifest,
      manifestInferred: inferred || manifest.inferred === true,
      // Authored manifests are rewritten too: the on-disk copy is what
      // `describe_table` reads, and a content update must reach it.
      manifestDirty: Boolean(authored) || inferred || !onDisk,
      state,
      inferenceSample: inferred ? sampleRows.slice(0, INFERENCE_SAMPLE_ROWS) : [],
      rowsWritten: 0,
      partitions: new Set(),
      sealedParts: [],
      open: new Map(),
    };
    this.tables.set(table, rt);
    return rt;
  }

  private async appendLines(
    rt: TableRuntime,
    table: string,
    partitionColumn: string,
    partition: string,
    lines: string[],
  ): Promise<void> {
    let part: OpenPart | undefined = rt.open.get(partition);

    // Split within the append rather than only between them. A source that
    // hands over one very large page would otherwise produce one very large
    // part, which the compactor then has to convert in a single pass — the
    // target is meant to bound part size, not merely to be checked once per
    // batch.
    let pending: string[] = [];
    let pendingBytes = 0;

    const flush = async () => {
      if (pending.length === 0) return;
      const payload = `${pending.join('\n')}\n`;
      const current = part as OpenPart;
      await new Promise<void>((resolve, reject) => {
        current.stream.write(payload, (err) => (err ? reject(err) : resolve()));
      });
      current.bytes += Buffer.byteLength(payload, 'utf8');
      pending = [];
      pendingBytes = 0;
      if (current.bytes >= this.partTargetBytes) {
        await this.sealPart(rt, table, partition);
        part = undefined;
      }
    };

    for (const line of lines) {
      if (!part) {
        part = await this.openPart(rt, table, partitionColumn, partition);
        rt.open.set(partition, part);
      }
      pending.push(line);
      pendingBytes += Buffer.byteLength(line, 'utf8') + 1;
      if (part.bytes + pendingBytes >= this.partTargetBytes) await flush();
    }
    if (!part && pending.length > 0) {
      part = await this.openPart(rt, table, partitionColumn, partition);
      rt.open.set(partition, part);
    }
    await flush();
  }

  private async openPart(
    rt: TableRuntime,
    table: string,
    partitionColumn: string,
    partition: string,
  ): Promise<OpenPart> {
    const relDir = `${tableRelDir(this.opts.corpusDir, table)}/${partitionDirName(
      partitionColumn,
      slug(partition, 64),
    )}`;
    const absDir = await resolveInside(this.opts.storageDir, relDir);
    await mkdir(absDir, { recursive: true });

    const ordinal = await nextFreeOrdinal(absDir, rt.state);
    const absPath = join(absDir, partName('open', ordinal, 'ndjson'));
    await mkdir(dirname(absPath), { recursive: true });
    return {
      absPath,
      stream: createWriteStream(absPath, { flags: 'a' }),
      bytes: existsSync(absPath) ? (await stat(absPath)).size : 0,
      ordinal,
    };
  }

  /**
   * Close an open part and rename it `open-` → `sealed-`. The rename is the
   * commit: a compactor only ever sees a file no writer still holds, so it
   * never converts a half-written page.
   */
  private async sealPart(rt: TableRuntime, table: string, partition: string): Promise<void> {
    const part = rt.open.get(partition);
    if (!part) return;
    rt.open.delete(partition);

    await new Promise<void>((resolve, reject) => {
      part.stream.end((err?: NodeJS.ErrnoException | null) => (err ? reject(err) : resolve()));
    });

    if (part.bytes === 0) {
      log.debug(`empty part discarded (${table}/${partition})`);
      return;
    }
    const sealed = join(dirname(part.absPath), partName('sealed', part.ordinal, 'ndjson'));
    await rename(part.absPath, sealed);
    rt.sealedParts.push(sealed);
  }
}

/**
 * Reserve the next part ordinal, skipping any already on disk. The counter is
 * persisted rather than derived because a retention sweep that deleted the
 * partition holding the highest ordinal would otherwise let a new part reuse
 * a name that a rollup watermark still refers to.
 */
async function nextFreeOrdinal(absDir: string, state: ObservationTableState): Promise<number> {
  let ordinal = state.nextPart;
  for (const prefix of ['open', 'sealed', 'part']) {
    while (
      existsSync(join(absDir, partName(prefix, ordinal, 'ndjson'))) ||
      existsSync(join(absDir, partName(prefix, ordinal, 'parquet')))
    ) {
      ordinal += 1;
    }
  }
  state.nextPart = ordinal + 1;
  return ordinal;
}

/**
 * Project a source row onto the manifest's declared columns. Unknown keys are
 * dropped and missing ones become null, which is what keeps every Parquet part
 * of a table mutually readable.
 */
export function coerceRow(
  raw: Record<string, unknown>,
  manifest: ObservationTableManifest,
): Record<string, unknown> {
  // Source keys are matched after the same normalization inference applied, so
  // a field named `Response Time` reaches the column it created.
  const bySafeName = new Map<string, unknown>();
  for (const [key, value] of Object.entries(raw)) bySafeName.set(safeColumnName(key), value);

  const out: Record<string, unknown> = {};
  for (const column of manifest.columns) {
    const value = bySafeName.has(column.name) ? bySafeName.get(column.name) : null;
    out[column.name] = coerceValue(value, column.type);
  }
  return out;
}

function coerceValue(value: unknown, type: ObservationTableManifest['columns'][number]['type']) {
  if (value === null || value === undefined) return null;
  switch (type) {
    case 'BOOLEAN':
      return typeof value === 'boolean' ? value : Boolean(value);
    case 'BIGINT': {
      if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : null;
      if (typeof value === 'bigint') return Number(value);
      const n = Number(value);
      return Number.isFinite(n) ? Math.trunc(n) : null;
    }
    case 'DOUBLE': {
      const n = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(n) ? n : null;
    }
    case 'JSON':
      return typeof value === 'string' ? value : JSON.stringify(value);
    case 'DATE':
    case 'TIMESTAMP':
    case 'VARCHAR':
      return typeof value === 'string' ? value : JSON.stringify(value);
    default:
      return String(value);
  }
}

/**
 * Decide which partition a row belongs to. The adapter's own answer wins — it
 * knows what page it fetched — then the manifest's partition column, then a
 * date derived from the time column, and finally a single bucket for tables
 * that genuinely have no time axis.
 */
export function resolvePartition(
  batchPartition: string | undefined,
  raw: Record<string, unknown>,
  coerced: Record<string, unknown>,
  manifest: ObservationTableManifest,
): string {
  if (batchPartition) return batchPartition;

  const partitionColumn = manifest.partitionColumn;
  if (partitionColumn) {
    const declared = coerced[partitionColumn] ?? raw[partitionColumn];
    if (typeof declared === 'string' && declared) return declared;
  }

  const timeColumn = manifest.timeColumn;
  if (timeColumn) {
    const value = coerced[timeColumn] ?? raw[timeColumn];
    const day = isoDay(value);
    if (day) return day;
  }
  return UNPARTITIONED;
}

/** Leading `YYYY-MM-DD` of a timestamp-ish value, or null. */
export function isoDay(value: unknown): string | null {
  if (typeof value === 'string') {
    const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
    if (match) return match[1] as string;
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString().slice(0, 10);
    return null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Heuristic on magnitude: seconds-since-epoch stays below ~1e11 well past
    // the year 5000, so anything larger is already milliseconds.
    const ms = value < 1e11 ? value * 1000 : value;
    return new Date(ms).toISOString().slice(0, 10);
  }
  return null;
}
