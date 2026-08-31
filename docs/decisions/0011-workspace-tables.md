# 0011 — Workspace tabular files become tables

Status: Accepted (2026-08)

## Context

[ADR 0009](./0009-observation-corpora.md) gave gezel a second corpus shape:
tabular data stored as Parquet and read through SQL, so a gezel answers
analytical questions without ever handling a row. It was reachable only from a
**connector sync** — `listProjectTables` iterated `project.connectors` and
returned early when that list was empty.

But the data users care about is often already in the project, and both common
shapes were handled badly at exactly the sizes that matter:

- **A CSV over `MAX_INDEXABLE_BYTES` is marked `trivial`**: enrolled for the
  deletion sweep, then given no chunks, no symbols, no enrichment. It is
  invisible to search *and* far too large to `read_file` — a dead end.
- **A spreadsheet converts to prose.** It gets a markdown shadow, so a gezel
  can read *about* the numbers but cannot aggregate them.

## Decision

Derive tables from workspace CSV, TSV and XLSX files, automatically and
asynchronously, and surface them through the same three tools as connector
tables.

### A workspace table is a snapshot, not a stream

This is the load-bearing distinction, and it is what keeps the feature small.

A connector corpus is append-only: time-partitioned, cursor-driven, growing
forever, and needing sealing, compaction, rollups and retention. A workspace
table is a **snapshot of one file**. When the file's content hash moves, the
whole table is rebuilt; when the file goes, the table goes.

So none of that machinery applies: no NDJSON landing buffer, no sealing, no
time partitioning, no rollups, no retention. One hash, one materialization,
replaced wholesale. `UNPARTITIONED` already existed for exactly this.

### The threshold is the indexer's own `trivial` line

A CSV becomes a table exactly where the indexer would otherwise give up on it.
Below that line the file is already chunked, searchable and readable, and a
table would be noise; above it, the file is invisible. Reusing the existing
constant makes the rule principled rather than a second magic number, and it
means the feature's scope is precisely the gap that already existed.

XLSX is exempt from the threshold: it is binary, so no size makes it readable
and the table is the only access a gezel will ever have.

### Two ingest paths, because the engine can only take one of them

Measured against the pinned DuckDB:

- **CSV needs no intermediate.** `read_csv` is built in and works under the
  full lockdown, and `sniff_csv` returns typed columns, delimiter and header
  detection. One `COPY`, and the schema comes from the engine.
- **XLSX cannot go through DuckDB at all.** `read_xlsx` lives in the `excel`
  extension, which is not installed and cannot be autoloaded or fetched once
  the prelude closes network access. Bundling that extension would mean four
  more signed native artifacts pinned to the exact DuckDB build, plus relaxing
  the prelude ordering to `LOAD` before the lock — the security-sensitive part.
  Rejected.

So a workbook takes the sandboxed squisq route, through the same isolated
worker that already produces its markdown shadow, in a second mode.

### Markdown is not the data path

squisq's `formattedNumberText` renders a percent-formatted `0.15` as `"15.0%"`,
an Excel date serial as text, and a zero-padded `7` as `"007"`. Reading a
spreadsheet's numbers out of its markdown means re-parsing formatted display
text and guessing back what the importer already knew.

squisq carries each cell's kind internally, so the fix was to expose the
underlying value (`XlsxCell.value`, plus an `xlsxToTables` export) rather than
to parse the rendering. Markdown remains the full-text-search path, where it is
exactly right.

### A sheet is not a table

A worksheet is several data islands with captions, notes and totals in the
gaps. squisq already detects those, so one workbook yields one table per
island, named from its caption or its sheet and anchor. `formulas` and `loose`
regions are excluded — useful to a reader, meaningless to a query.

### Its own reserved subtree, and its own gate table

Tables land in `artifacts/tabular/`, write-denied **unconditionally**, unlike a
connector corpus whose guard fires only for gezel-initiated writes. The
asymmetry is deliberate: a connector mirror is arguably the user's to edit, but
a derived table would simply be overwritten on the source file's next change,
so accepting the write would be a lie.

The work gate is a new `tabular_state` table rather than a reuse of
`shadow_state` or the `doc:convert` metadata key. Both already gate a different
pass over some of the same files — an `.xlsx` wants *both* a markdown shadow
and a table — and sharing a gate lets one pass's success permanently suppress
the other's work. That failure is already recorded in the schema for
`embed_state`; this avoids repeating it.

## Consequences

- **A previously invisible class of file becomes both findable and
  queryable.** The drain writes a thin **table card** into the shadow tree so a
  large CSV stops being absent from keyword search — names and shape only,
  never rows, because rows in the index are the vector-space poisoning ADR 0009
  exists to prevent.
- **`listProjectTables` is now a union of sources**, and `ObservationTableRef`
  carries `source` and `sourceLabel`. For a workspace table that label is the
  **file path**, because "which spreadsheet is this?" is the question a user
  actually asks.
- **The prompt block had to become standalone.** It used to be a sentence
  inside `### Connected data`, which renders from `project.connectors` — so a
  project holding nothing but spreadsheets would never have seen it.
- **Ordering at night matters.** The workspace drain runs *before* the nightly
  maintenance checks whether a project has tables: a project whose only tabular
  content was deferred has none yet, and checking first would skip it forever.
- **XLSX support is gated on a squisq release**, since it needs the typed
  export. CSV shipped first and independently.

## Alternatives considered

- **Bundle DuckDB's `excel` extension** and read XLSX directly. Four more
  signed platform artifacts pinned to the exact engine build, and a
  `LOAD`-before-lock relaxation of the security prelude, to avoid one
  sandboxed converter call that already exists for this file type.
- **Parse the markdown shadow already being produced.** Free, and wrong: see
  the formatting losses above. Acceptable for exploration, not for arithmetic.
- **Treat workspace tables as a synthetic connector corpus** under
  `data/workspace/`. Less new code — the `corpusDir` plumbing would work
  unchanged — but it would assert a binding that does not exist and quietly
  subject a snapshot to stream machinery.
- **Make it opt-in per project.** Zero surprise, but nothing happens
  automatically, which is the whole point. The size threshold turned out to be
  a better gate than a switch: it fires only where reading was never an option.
