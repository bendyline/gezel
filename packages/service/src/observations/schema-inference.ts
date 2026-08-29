/**
 * Infer an observation table's schema from the rows that actually landed.
 *
 * Most tables get an **authored** manifest from their gilde connector-type —
 * that is the point of keeping table semantics as content. This module covers
 * the other case: a source whose shape is only knowable at runtime. Without it
 * an unknown source would be unqueryable; with it the corpus is queryable
 * immediately, honestly labelled `inferred: true` so `describe_table` can say
 * the types are a guess from a sample.
 *
 * Inference is done in JS over the observed values rather than by handing the
 * file to DuckDB's `read_json_auto`, for a reason that matters: whatever we
 * infer here is then passed to the compactor as an explicit `columns = {…}`
 * struct. Deriving the schema and enforcing it from one place means every
 * Parquet part for a table has identical column types. Letting each part
 * auto-type itself is exactly how `route` ends up VARCHAR in one file and
 * NULL-typed in another, after which the glob read fails and the table
 * appears to vanish.
 *
 * Widening is one-way and conservative: BOOLEAN → BIGINT → DOUBLE → VARCHAR.
 * A column that is integral in the first thousand rows and fractional in the
 * next becomes DOUBLE, not two incompatible parts.
 */

import type {
  ObservationColumn,
  ObservationColumnType,
  ObservationTableManifest,
} from '@bendyline/gezel';

/** Rows sampled before the schema is fixed. Beyond this, later rows coerce. */
export const INFERENCE_SAMPLE_ROWS = 1_000;

/** Widening lattice; higher index absorbs lower. */
const WIDENING_ORDER: ObservationColumnType[] = ['BOOLEAN', 'BIGINT', 'DOUBLE', 'VARCHAR'];

function widen(a: ObservationColumnType, b: ObservationColumnType): ObservationColumnType {
  if (a === b) return a;
  // JSON and the temporal types do not participate in numeric widening: a
  // column that is sometimes an object and sometimes a scalar is a VARCHAR of
  // JSON text, which at least round-trips.
  if (a === 'JSON' || b === 'JSON') return 'JSON';
  if (a === 'TIMESTAMP' || b === 'TIMESTAMP' || a === 'DATE' || b === 'DATE') return 'VARCHAR';
  const ia = WIDENING_ORDER.indexOf(a);
  const ib = WIDENING_ORDER.indexOf(b);
  if (ia < 0 || ib < 0) return 'VARCHAR';
  return WIDENING_ORDER[Math.max(ia, ib)] as ObservationColumnType;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?/;

/** Physical type of one observed value, or null for null/undefined. */
export function inferValueType(value: unknown): ObservationColumnType | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return 'BOOLEAN';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 'DOUBLE';
    return Number.isInteger(value) ? 'BIGINT' : 'DOUBLE';
  }
  if (typeof value === 'bigint') return 'BIGINT';
  if (typeof value === 'object') return 'JSON';
  if (typeof value === 'string') {
    if (ISO_TIMESTAMP.test(value)) return 'TIMESTAMP';
    if (ISO_DATE.test(value)) return 'DATE';
    return 'VARCHAR';
  }
  return 'VARCHAR';
}

/**
 * Column names are executable text — they are interpolated into the
 * compactor's `columns = {…}` struct — so a name that is not already a safe
 * identifier is rewritten rather than trusted. Rewriting (over rejecting)
 * keeps an awkwardly-named upstream field queryable instead of silently
 * dropping the data it carries.
 */
export function safeColumnName(raw: string): string {
  const cleaned = raw
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
  if (!cleaned) return 'col';
  return /^[a-z_]/.test(cleaned) ? cleaned : `c_${cleaned}`;
}

export interface InferSchemaOptions {
  table: string;
  /** Preserved when re-inferring, so a partition column stays stable. */
  partitionColumn?: string;
  timeColumn?: string;
}

/**
 * Build a manifest from sampled rows. Column order follows first appearance,
 * which keeps a table's shape stable across re-inference of the same source.
 */
export function inferTableManifest(
  rows: readonly Record<string, unknown>[],
  opts: InferSchemaOptions,
): ObservationTableManifest {
  const types = new Map<string, ObservationColumnType>();
  const examples = new Map<string, string[]>();
  const distinct = new Map<string, Set<string>>();
  const originalName = new Map<string, string>();

  for (const row of rows.slice(0, INFERENCE_SAMPLE_ROWS)) {
    for (const [rawKey, value] of Object.entries(row)) {
      const key = safeColumnName(rawKey);
      if (!originalName.has(key)) originalName.set(key, rawKey);
      const observed = inferValueType(value);
      if (observed === null) {
        // Seen only as null so far: register the column so it survives into
        // the schema, and let a later row decide its type.
        if (!types.has(key)) types.set(key, 'VARCHAR');
        continue;
      }
      types.set(key, types.has(key) ? widen(types.get(key) as ObservationColumnType, observed) : observed);

      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        const text = String(value);
        if (text.length <= 200) {
          const seen = distinct.get(key) ?? new Set<string>();
          // Bounded: cardinality here is only a hint, and an unbounded set
          // over a million-row page is a memory leak wearing a statistic.
          if (seen.size < 64) seen.add(text);
          distinct.set(key, seen);
          const ex = examples.get(key) ?? [];
          if (ex.length < 3 && !ex.includes(text)) ex.push(text);
          examples.set(key, ex);
        }
      }
    }
  }

  const sampleSize = Math.min(rows.length, INFERENCE_SAMPLE_ROWS);
  const columns: ObservationColumn[] = [...types.entries()].map(([name, type]) => {
    const seen = distinct.get(name);
    const ex = examples.get(name) ?? [];
    return {
      name,
      type,
      role: roleFor(name, type, seen?.size ?? 0, sampleSize, opts),
      ...(originalName.get(name) !== name
        ? { description: `Source field \`${originalName.get(name)}\`.` }
        : {}),
      ...(seen && seen.size > 0
        ? { cardinalityHint: seen.size >= 64 ? '64+ distinct in sample' : `~${seen.size} distinct in sample` }
        : {}),
      ...(ex.length > 0 ? { examples: ex } : {}),
    };
  });

  // A table with no rows yet still needs a valid manifest (>= 1 column), or
  // it cannot round-trip through the schema. A placeholder is honest and is
  // replaced the moment real rows land.
  if (columns.length === 0) {
    columns.push({ name: 'raw', type: 'JSON', role: 'attribute' });
  }

  const timeColumn = opts.timeColumn ?? columns.find((c) => c.role === 'time')?.name;

  return {
    schemaVersion: 1,
    table: opts.table,
    grain: 'one row per source record',
    ...(timeColumn ? { timeColumn } : {}),
    ...(opts.partitionColumn ? { partitionColumn: opts.partitionColumn } : {}),
    columns,
    measures: [],
    exemplars: [],
    rollups: [],
    inferred: true,
  };
}

/**
 * Guess what a column is for. Crude on purpose — an inferred manifest advertises
 * itself as inferred, and a wrong role costs a model one `describe_table` read,
 * whereas a wrong *type* costs a failed query.
 */
function roleFor(
  name: string,
  type: ObservationColumnType,
  distinctCount: number,
  sampleSize: number,
  opts: InferSchemaOptions,
): ObservationColumn['role'] {
  if (opts.timeColumn === name) return 'time';
  if (type === 'TIMESTAMP' || type === 'DATE') return 'time';
  if (/^(id|.*_id|uuid|guid|trace|span|request_id)$/.test(name)) return 'identifier';
  if (type === 'BIGINT' || type === 'DOUBLE') return 'measure';
  if (type === 'JSON') return 'attribute';
  // A low-cardinality string is what a question means by "by".
  if (distinctCount > 0 && sampleSize > 0 && distinctCount < Math.max(2, sampleSize / 4)) {
    return 'dimension';
  }
  return 'attribute';
}
