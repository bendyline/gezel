/**
 * Turn a generic driver's raw page into an {@link ObservationBatch}.
 *
 * Shared by the `script` and `mcp` drivers so a tabular source is a manifest
 * rather than a compile — the same bet the document drivers make, and the
 * reason a new high-volume source should not need a native adapter.
 *
 * ── Where the configuration lives, and why ────────────────────────────────
 *
 * The row mapping goes in the manifest's **`source`** block, beside the other
 * driver-interpreted fetch config, while `normalize.tables` carries the
 * semantic layer. That split is not arbitrary: `source` answers "how do I get
 * a row out of what this API returned", which is a property of the driver and
 * the endpoint, and `tables` answers "what does this column mean", which is a
 * property of the data and is what `describe_table` renders. It also keeps a
 * new source additive — `source` is a free-form record in the core schema, so
 * a mapping change needs no schema release.
 *
 * ── One ref is one page ───────────────────────────────────────────────────
 *
 * The document drivers map each item in a page to its own `RecordRef`. Here
 * the whole page becomes a single ref carrying the items in `raw`, because
 * the sync engine's caps count refs: at one ref per row a 10,000-row page
 * would blow the backfill limit and be silently windowed, while at one ref
 * per page the existing limits bound pages and the row ceiling is millions.
 */

import { jget } from './normalize.js';
import type { ObservationBatch, RecordRef } from './types.js';

/** Driver-interpreted `source` fields that describe a tabular page. */
export interface ObservationSourceSpec {
  /** Table these rows belong to. Ignored when `tablePath` resolves. */
  table?: string;
  /** Per-item path naming the table, for a source that multiplexes. */
  tablePath?: string;
  /**
   * Column → path into the raw item. Absent means pass the item through
   * as-is and let the writer project it onto the declared columns, which is
   * the right default for an API that already returns flat rows.
   */
  rowMap?: Record<string, string>;
  /** Path to a per-item timestamp, used to derive the partition. */
  tsPath?: string;
  /** Fixed partition for the whole page (rare; usually derived per row). */
  partition?: string;
}

/** True when this manifest's `normalize` declares the tabular shape. */
export function isObservationNormalize(normalize: unknown): boolean {
  return (normalize as { kind?: string } | undefined)?.kind === 'observations';
}

/**
 * Wrap a page of raw items as the single `RecordRef` the sync engine will
 * hand back to `fetchRecord`.
 *
 * `ordinalKey` ascends with the page index so the engine's newest-first sort
 * agrees with forward paging instead of reversing it.
 */
export function observationPageRef(items: readonly unknown[], pageIndex: number): RecordRef {
  return { id: `page-${pageIndex}`, ordinalKey: pageIndex, raw: items };
}

/** Rows carried by an observation page ref, whatever shape the driver used. */
export function pageItems(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  return raw === null || raw === undefined ? [] : [raw];
}

/**
 * Project one page onto rows for a single table.
 *
 * A source that multiplexes tables (`tablePath`) is split into one batch per
 * table, because a batch is the unit the writer partitions and seals.
 */
export function toObservationBatches(
  raw: unknown,
  spec: ObservationSourceSpec,
  fallbackTable: string,
): ObservationBatch[] {
  const items = pageItems(raw);
  const byTable = new Map<string, Record<string, unknown>[]>();

  for (const item of items) {
    const table = resolveTable(item, spec, fallbackTable);
    const rows = byTable.get(table) ?? [];
    rows.push(projectRow(item, spec));
    byTable.set(table, rows);
  }

  return [...byTable.entries()].map(([table, rows]) => ({
    table,
    rows,
    ...(spec.partition ? { partition: spec.partition } : {}),
  }));
}

function resolveTable(item: unknown, spec: ObservationSourceSpec, fallback: string): string {
  if (spec.tablePath) {
    const named = jget(item, spec.tablePath);
    if (typeof named === 'string' && named.trim()) return named.trim();
  }
  return spec.table ?? fallback;
}

/**
 * Apply the column mapping, or pass the item through when none is declared.
 *
 * A mapped column whose path misses becomes `null` rather than being omitted:
 * the writer coerces to the declared schema either way, but an explicit null
 * makes "the source stopped sending this field" visible in the data instead
 * of looking like a column that was never mapped.
 */
function projectRow(item: unknown, spec: ObservationSourceSpec): Record<string, unknown> {
  if (!spec.rowMap) {
    return item !== null && typeof item === 'object' && !Array.isArray(item)
      ? (item as Record<string, unknown>)
      : { value: item };
  }
  const row: Record<string, unknown> = {};
  for (const [column, path] of Object.entries(spec.rowMap)) {
    const value = jget(item, path);
    row[column] = value === undefined ? null : value;
  }
  return row;
}

/**
 * Derive the newest timestamp in a page, for a source with no cursor of its
 * own. Mirrors `deriveWindowCursor` on the document side.
 */
export function newestTimestamp(raw: unknown, tsPath: string | undefined): string | undefined {
  if (!tsPath) return undefined;
  let newest: string | undefined;
  for (const item of pageItems(raw)) {
    const ts = jget(item, tsPath);
    if (typeof ts === 'string' && (newest === undefined || ts > newest)) newest = ts;
  }
  return newest;
}
