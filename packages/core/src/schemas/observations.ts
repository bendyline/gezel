import { z } from 'zod';

/**
 * The semantic layer for an observation table — the on-disk `manifest.json`
 * that sits beside a table's partitioned data files.
 *
 * This is the table's `about.md`, and it is the single thing that decides
 * whether a model is any good at querying the corpus. A model handed two
 * hundred bare column names writes confident, wrong SQL; a model handed
 * units, roles, cardinality hints and a handful of worked examples writes
 * SQL that answers the question. Everything here exists to be rendered into
 * `describe_table` output, never into the system prompt — the prompt budget
 * compounds at depth, so the table list goes in the prompt and the column
 * documentation is fetched on demand.
 *
 * Manifests have two producers. Most are **authored** in a gilde
 * connector-type manifest and materialized here on first sync, which is what
 * makes table semantics shippable as content rather than as an app release.
 * A table whose shape is only discoverable at runtime gets an **inferred**
 * manifest (`inferred: true`) built by probing the landed rows, so an
 * unknown source is still queryable — just with thinner documentation, and
 * honestly labelled as such.
 */

/** What a column is *for*, which is what tells a model how to use it. */
export const ObservationColumnRoleSchema = z.enum([
  /** The event timestamp. At most one per table; drives partition derivation. */
  'time',
  /** A grouping key — the things a question says "by". */
  'dimension',
  /** A numeric fact to aggregate. */
  'measure',
  /** Identity/correlation only: high-cardinality, never a useful GROUP BY. */
  'identifier',
  /** Carried for completeness; not expected in analysis. */
  'attribute',
]);
export type ObservationColumnRole = z.infer<typeof ObservationColumnRoleSchema>;

/**
 * A column's physical type, named in DuckDB's spelling because that is what
 * the compactor passes to `read_ndjson(columns = …)` and what a model writing
 * SQL will cast against. Deliberately a closed set: an open string would let a
 * manifest smuggle arbitrary text into a generated DDL fragment.
 */
export const ObservationColumnTypeSchema = z.enum([
  'BOOLEAN',
  'BIGINT',
  'DOUBLE',
  'VARCHAR',
  'DATE',
  'TIMESTAMP',
  'JSON',
]);
export type ObservationColumnType = z.infer<typeof ObservationColumnTypeSchema>;

export const ObservationColumnSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(120)
    // Bounded to a SQL-safe identifier: the compactor interpolates these into
    // a `columns = {…}` struct, so a column name is executable text.
    .regex(/^[a-z_][a-z0-9_]*$/, 'column names are lowercase snake_case identifiers'),
  type: ObservationColumnTypeSchema,
  role: ObservationColumnRoleSchema.default('attribute'),
  description: z.string().max(500).optional(),
  /** e.g. `milliseconds`, `bytes`, `requests`. Prevents unit-confused answers. */
  unit: z.string().max(60).optional(),
  /** Free-form hint (`~200`, `high`, `one per customer`) shown to the model. */
  cardinalityHint: z.string().max(120).optional(),
  /** A few real values. Worth more than any prose description. */
  examples: z.array(z.string().max(200)).max(8).optional(),
});
export type ObservationColumn = z.infer<typeof ObservationColumnSchema>;

/** A named aggregate the table's author considers canonical. */
export const ObservationMeasureSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[a-z_][a-z0-9_]*$/, 'measure names are lowercase snake_case identifiers'),
  /** SQL aggregate expression, e.g. `quantile_cont(latency_ms, 0.95)`. */
  sql: z.string().min(1).max(2000),
  description: z.string().max(500).optional(),
  unit: z.string().max(60).optional(),
});
export type ObservationMeasure = z.infer<typeof ObservationMeasureSchema>;

/**
 * A worked example. The highest-leverage field in the whole manifest: one
 * correct query against this table teaches more than every description
 * combined, because it shows the model the partition predicate, the
 * table name, and the house style all at once.
 */
export const ObservationExemplarSchema = z.object({
  question: z.string().min(1).max(300),
  sql: z.string().min(1).max(4000),
});
export type ObservationExemplar = z.infer<typeof ObservationExemplarSchema>;

/**
 * A pre-aggregate the night shift materializes so a common question hits a
 * thousand rows instead of a billion. Rollups are never deleted by retention;
 * that asymmetry with raw data is the point of the tier.
 */
export const ObservationRollupSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[a-z_][a-z0-9_]*$/, 'rollup names are lowercase snake_case identifiers'),
  /** Columns the rollup groups by, for display and for staleness reasoning. */
  grain: z.array(z.string().min(1).max(120)).min(1).max(16),
  /** `{{table}}` interpolates to the raw-table view at materialization time. */
  sql: z.string().min(1).max(8000),
  description: z.string().max(500).optional(),
});
export type ObservationRollup = z.infer<typeof ObservationRollupSchema>;

export const ObservationRetentionSchema = z.object({
  /**
   * Days of raw rows to keep. Absent means keep everything — the safe
   * default, since deleting a user's mirrored data is not something to do by
   * omission. Rollups outlive raw partitions regardless.
   */
  rawDays: z.number().int().positive().max(36_500).optional(),
});
export type ObservationRetention = z.infer<typeof ObservationRetentionSchema>;

export const ObservationTableManifestSchema = z.object({
  schemaVersion: z.literal(1),
  /** Table slug; also the directory name under the corpus's `tables/`. */
  table: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9][a-z0-9_-]*$/, 'table names are lowercase slugs'),
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  /** What one row *is* — "one row per HTTP request". Prevents double-counting. */
  grain: z.string().max(300).optional(),
  /** Name of the `time`-role column, when the table has one. */
  timeColumn: z.string().max(120).optional(),
  /**
   * Physical partition column. Written as a Hive-style directory level
   * (`dt=2026-08-28/`) and therefore prunable — a query that filters on it
   * reads only the partitions it needs, which is most of why this scales.
   */
  partitionColumn: z.string().max(120).optional(),
  columns: z.array(ObservationColumnSchema).min(1).max(512),
  measures: z.array(ObservationMeasureSchema).max(64).default([]),
  exemplars: z.array(ObservationExemplarSchema).max(32).default([]),
  rollups: z.array(ObservationRollupSchema).max(32).default([]),
  retention: ObservationRetentionSchema.optional(),
  /**
   * True when the schema was probed from landed data rather than authored.
   * Surfaced verbatim to the model and the UI: an inferred manifest's types
   * are a guess from one sample, and saying so is cheaper than an answer
   * built on a column the prober mistyped.
   */
  inferred: z.boolean().optional(),
});
export type ObservationTableManifest = z.infer<typeof ObservationTableManifestSchema>;
