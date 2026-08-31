# Observation corpora

[connectors.md](./connectors.md) is the architectural thesis for connectors and
[connector-standards.md](./connector-standards.md) is the normative contract for
the **document** shape — one markdown file per record. This document is the
contract for the **second** shape: high-volume tabular data, mirrored as
partitioned columnar files and read back with SQL.

It is written for anyone adding a tabular connector type, touching the writer,
the compactor, the query layer, or the night-shift maintenance pass.

The decision and its alternatives are in
[ADR 0009](./decisions/0009-observation-corpora.md).

## Why a second shape exists

A document corpus is right for mail, issues, calendar entries, wiki pages —
corpora in the 10³–10⁴ range where each record is prose a human would read. It
is wrong, by four to six orders of magnitude, for the sources users most want
to reason over: Azure Monitor and Log Analytics, CDN and Front Door request
logs, billing exports, event streams. Three independent failures:

1. **Filesystem.** One file per record is a million inodes per binding per day.
2. **Retrieval is the wrong instrument.** No amount of embedding produces
   `p95 latency by route by hour`. That is `GROUP BY`, not similarity.
3. **Vector retrieval actively degrades.** Log rows are near-identical text;
   embedding them collapses the vector space, and the symptom — "search returns
   the same documents for every query" — would be inflicted on the *other*
   corpora in the same project.

The load-bearing difference is the AI access path. A connector already isolates
credentials from the model. An observation corpus additionally isolates
**rows**: the gezel writes a query and reads a result set. That is what
decouples corpus size from context size, and it is why the document corpus has
a `MAX_ARTIFACT_FILES = 20_000` ceiling and this one does not.

| | Document corpus | Observation corpus |
|---|---|---|
| Unit | a record a human reads | a row nobody reads individually |
| Identity | `recordId`, refresh-in-place | `(scope, partition, part)`, append-only |
| Retrieval | search → files | query → result set |
| AI access | reads the files | reads the *answer* |
| Lifecycle | keep forever | retention + rollup tiering |
| Prune | mirror types prune vanished records | never; append-only |

## 0. Two sources, one shape

Tables reach a project two ways, and the difference is worth holding onto
because it decides how each is maintained:

| | **Connector corpus** | **Workspace table** |
|---|---|---|
| Comes from | a synced external system | a file already in the project |
| Lives at | `artifacts/data/<corpus>/tables/` | `artifacts/tabular/<file>_tables/tables/` |
| Lifecycle | append-only **stream** | **snapshot** of one file |
| Grows by | a cursor advancing | the file being edited |
| Needs | sealing, compaction, rollups, retention | none of those |
| Rebuilt when | never (rows are immutable) | the file's content hash moves |
| Disappears when | the binding is unbound | the file is deleted |

Both are read through the same `list_tables` / `describe_table` /
`query_table`, and both use the same layout helpers, manifest schema and
query path — `corpusDir` is an opaque artifact-relative string everywhere, so
nothing below the discovery layer knows or cares which kind it is holding.

The snapshot/stream distinction is recorded in
[ADR 0011](./decisions/0011-workspace-tables.md).

## 1. Declaring the shape

A connector type opts in through `normalize`:

```jsonc
"normalize": {
  "kind": "observations",
  // Optional. Present = an authored semantic layer ships with the type.
  // Absent = the schema is inferred from the rows that land, and labelled
  // as inferred wherever it is shown.
  "tables": [ /* ObservationTableManifest */ ]
}
```

**Where the row mapping goes, and why it is not here.** A generic driver's
column mapping lives in the manifest's **`source`** block
(`table`, `tablePath`, `rowMap`, `tsPath`, `partition`), beside the rest of the
driver's fetch configuration. `source` answers *"how do I get a row out of this
endpoint"* — a property of the driver and the API. `normalize.tables` answers
*"what does this column mean"* — a property of the data, and the thing
`describe_table` renders. Keeping the mapping in `source` also keeps new
sources additive: `source` is a free-form record in the core schema, so adding
one needs no schema release.

## 2. One `RecordRef` is one page

This is the rule most likely to be got wrong, because it inverts the document
contract.

In a document corpus one `RecordRef` is one record. In an observation corpus
**one `RecordRef` is one page of rows**. The sync engine's `backfillLimit`
(default 500, capped at 5,000) and `MAX_PARTIAL_ROUNDS` count refs, so mapping
a 10,000-row page to 10,000 refs would silently window most of it away — the
engine would take the newest 500 and log an overflow. Per page, those same
constants bound *pages*, and the ceiling becomes hundreds of millions of rows
per pass with nothing changed.

`fetchRecord` returns `{ kind: 'observations', batches }`. **Plural**: a single
fetched page can span several tables — a query API answering "here are your
requests and your exceptions" is ordinary — and that cannot be split into
separate refs before the fetch has happened.

## 3. On-disk layout

```
artifacts/data/<corpusName>/
├── _meta.json                     shape: "observations", plus table summaries
├── _actions/                      unchanged; the mutable surface
└── tables/
    └── <table>/
        ├── manifest.json          the semantic layer
        ├── state.json             part counter, watermarks, nightly key
        ├── dt=2026-08-28/
        │   ├── part-000123.parquet   sealed, immutable
        │   ├── sealed-000124.ndjson  awaiting compaction
        │   └── open-000125.ndjson    this pass's landing buffer
        └── rollups/<name>/dt=…/part-000000.parquet
```

A workspace table's layout is the same one level down:

```
artifacts/tabular/<parent>/<basename>_tables/     ← corpusDir
└── tables/<table>/
    ├── manifest.json
    ├── state.json
    └── part=all/part-000000.parquet
```

Companion directories keep the source's **full basename** (`sales.xlsx_tables`),
so `X_tables` → `X` is a lossless reverse map for orphan collection and `a.csv`
cannot collide with `a.xlsx` — the same reasoning as the shadow tree's `_files`
convention. Reusing the inner `tables/` level is what makes the artifacts
indexer skip the whole subtree for free, since it excludes that directory name
at any depth.

`tables/` is deliberately **not** underscore-prefixed. Inside a corpus the
underscore marks the *mutable* surface, and `isProtectedConnectorCorpusPath`
already denies gezel writes to everything under `data/` that lacks one. A bare
name inherits that guard rather than needing a second one that could drift.

Partitions are Hive-style directory levels (`dt=<value>`) because that is what
lets a filter on the partition column *prune* whole directories. Most of the
reason this scales is that a question about last week never opens last year.

## 4. NDJSON lands, Parquet compacts

Rows land as newline-delimited JSON and a later pass converts sealed parts to
Parquet with the bundled DuckDB CLI. Three consequences, all deliberate:

- **No Parquet encoder in Node.** The engine gezel already ships for querying
  does the writing too, so the dependency count stays at one.
- **Crash safety is free.** A torn append loses at most a trailing line, and
  the compactor's row-count check catches it.
- **Fresh data is queryable immediately.** Views union Parquet *and*
  un-compacted NDJSON, so a sync from two minutes ago is answerable before the
  night shift has touched it.

Two rules the compactor enforces:

1. **Always pass explicit `columns=` from the manifest. Never `read_json_auto`.**
   Auto-typing decides each file's schema in isolation, so a column that is
   integral on Monday and fractional on Tuesday produces two mutually
   unreadable files — surfacing later as a glob read error that looks like
   corruption rather than schema drift.
2. **Verify before publishing.** The Parquet row count must equal the NDJSON
   line count. A truncated source otherwise becomes a smaller, perfectly valid
   Parquet file, and silent row loss in an analytics corpus is the worst
   failure available: every later answer is confidently wrong. On mismatch both
   files are kept and the error is recorded.

Publishing is write-to-`.tmp` → verify → `rename` → delete the source, so a
reader never sees a partial part.

## 4b. Where the engine comes from

DuckDB is **vendored, not built**. The DuckDB Foundation publishes a
precompiled single-file CLI that is already Developer ID signed and notarized
on macOS and Authenticode signed on Windows, so Gezel redistributes those exact
bytes and never re-signs them — the same provenance rule the bundled Node
runtime follows. It is therefore *not* part of the `native/` build pipeline and
has no artifact in the `native-v*` release.

One pin, in [`packages/core/src/native/duckdb-pin.ts`](../packages/core/src/native/duckdb-pin.ts),
records the version, the commit, and **two** digests per platform: the
published archive and the executable inside it. Two consumers read it —
`packages/app/scripts/fetch-duckdb.mjs` stages the binary into the installer at
build time, and the service's engine resolver downloads it for npm / CLI
installs. Both verify both digests and both land the result in
`<home>/engines/duckdb/<version>/`, so a machine running the desktop app and an
npm `gezeld` shares one verified copy.

`DuckRunner` then resolves in descending order of what we can vouch for:
`GEZEL_DUCKDB_BIN` → that pinned install → `~/.duckdb/cli/latest/` (where
DuckDB's own installer puts it) → `PATH`. The ordering is a security decision:
everything in section 5 is a behavioural contract measured against the pinned
build, so a system DuckDB of unknown vintage must never outrank it. The
resolved rung is logged at boot, with a warning when it is unverified.

Bump with `node scripts/bump-duckdb.mjs <version>` — and treat it as a security
review, re-running the matrix below against the new binary.

## 5. Querying, and the guard that makes it safe

`DuckRunner` runs one short-lived CLI child per statement, SQL on **stdin**
(never `argv`), results back as JSON. Every run applies a configuration prelude
and then `SET lock_configuration = true`.

**The statement guard is load-bearing, not defence in depth.** Read
[statement-guard.ts](../packages/service/src/observations/statement-guard.ts)
before changing anything here. Measured against the pinned engine:

| Attempt | Config lockdown alone |
| --- | --- |
| read outside the corpus, remote URL, `INSTALL`, `COPY` out | blocked |
| re-widen `allowed_directories` / `enable_external_access` | blocked (locked) |
| **`ATTACH '<corpus>/x.db'` + `CREATE TABLE`** | **allowed — writes a real file** |

And a leading-keyword allowlist is not enough either: `WITH c AS (…) INSERT
INTO t …` executes the insert, `EXPLAIN ANALYZE INSERT …` executes the insert,
and the row-limit wrapper `SELECT * FROM (<sql>) LIMIT n` is itself an
injection surface — a statement of `SELECT 1) ; ATTACH … ; SELECT * FROM
(SELECT 1` closes the parenthesis and smuggles two more.

So the authoritative check is **DuckDB's own parser**, via
`json_serialize_sql`, which refuses anything that is not a single SELECT and
reports the statement count. It parses without executing, so validation is
inert. A cheap lexical pass runs first only to turn the common mistakes into a
clear message.

## 6. The semantic layer

`tables/<table>/manifest.json` is the table's `about.md`, and it is the single
thing that decides whether a model is any good at querying the corpus. A model
handed two hundred bare column names writes confident, wrong SQL; one handed
units, roles, cardinality hints and a few worked examples writes SQL that
answers the question.

It is rendered by `describe_table` and **never** injected into the system
prompt — the prompt budget compounds at depth, so the prompt gets the table
*list* and the columns are fetched on demand.

Two producers:

- **Authored** in a gilde connector-type manifest, materialized on first sync.
  This is the point of the content/loader split: table semantics ship as
  content, PR-able and releasable without an app build.
- **Inferred** from the rows that land, marked `inferred: true` so
  `describe_table` can say the types are a guess from a sample. Right for a
  generic endpoint whose columns differ per binding.

A native adapter can do better than either when the source reports its own
types — `azure-monitor-logs` derives the schema from Azure's typed column
list, which is the main reason it is native rather than a manifest.

## 7. The AI surface

Three tools, registered **only** for projects that hold a tabular corpus (the
chat manager sets `GEZEL_TABLES_ENABLED` after a directory probe, the same
gating the mail and social write tools use). The tool listing rides in every
system prompt, so three tools a project can never use are pure prompt cost —
and a model that sees a tool reaches for it.

- **`list_tables`** — what is here, how big, how current.
- **`describe_table`** — the grounding step. Columns, roles, units,
  cardinality, the partition column to filter on, worked examples.
- **`query_table`** — one read-only statement, bounded rows back.

`query_table` is in `OUTBOARD_STORAGE_TOOLS`, so a deliberately widened result
spills to an artifact the model can slice or grep rather than being truncated
mid-result. The wrapper no-ops when no artifact writer is wired, so a
writes-off roster degrades to the inline cap instead of being told to use a
tool it does not have.

**Security posture.** These tools read local artifact files the gezel may
already read and move no data off the machine, so they ride at every security
level, like `read_artifact` — *not* on `allowConnectorData` (which gates the
network *fetch*) and not on `allowScriptExecution` (this is a first-party
binary running one parser-validated statement, not arbitrary code).

## 8. Night-shift maintenance

Daytime syncs land rows and stop. Compaction is minutes of CPU on a large pass
and the rows are already queryable, so three jobs wait for the quiet hours,
**in this order**:

1. **Compaction catch-up** — sealed NDJSON becomes Parquet.
2. **Rollups** — declared pre-aggregates are materialized, one Parquet file per
   raw partition, recomputing only partitions whose data changed since the
   rollup's watermark.
3. **Retention** — raw partitions past their keep-window are deleted.

**The ordering is a safety property.** Retention runs last and refuses a
partition unless *all three* hold: it is past `retention.rawDays`, every
declared rollup already covers it, and it holds no uncompacted NDJSON.
Deleting raw data before it has been summarized destroys the only copy, and it
is unrecoverable — the upstream window has usually moved on. Retention is also
opt-in (`rawDays` absent = keep everything), and a partition whose value is not
a date is never pruned, because there is no ordering to reason about.

Rollups are never deleted. That asymmetry is the entire point of the tier: the
answers outlive the rows they were computed from.

Authored rollup SQL goes through the same parser gate as a user's query.
Manifest content is reviewed, but it is still interpolated into a script that
runs, and one extra parse per rollup per night buys the guarantee that a
manifest cannot smuggle a second statement.

## 9. Testing

None of these layers needs a network, a credential, or even the real engine:

- **Fake DuckDB CLI** — a shell script echoing canned JSON, for the runner's
  plumbing (prelude assembly, stdin framing, awake-budget timeout,
  process-group kill, env scrubbing). Runs everywhere.
- **Real-engine suites** — `describe.runIf(hasRealDuckdb())`, for the things a
  fake cannot answer: actual SQL semantics and every sandbox assertion.
- **Deterministic synthetic data** — seeded, never `Math.random`, with ground
  truth computed independently in JS so an aggregate can be checked rather than
  snapshotted.
- **`mock-observations`** — the `MockProvider` of this subsystem, carrying the
  failure modes worth rehearsing (rate limit, mid-page throw, miscounted page).
- **Fixture-replayed native adapters** — an injected runtime seam, redacted
  payloads inline as `const`s, and header hygiene asserted (no credential in a
  URL, a body, or across an origin change).

## 11. Workspace files → tables

### Which files, and why that line

- **CSV/TSV: exactly when the indexer would otherwise mark it `trivial`** —
  above `MAX_INDEXABLE_BYTES` or `isDenseBlob`. Below that line the file is
  already chunked, searchable, and readable with `read_file`, and a table adds
  noise; above it, the file is invisible to search *and* too big to read, which
  is a dead end. Reusing the existing constant makes the rule principled rather
  than a new magic number.
- **XLSX: always.** A gezel cannot read the binary at any size, so the table is
  the only access it will ever have.
- Nothing `discoverWorkspaceFiles` already excludes (`.gitignore`), nothing
  whose path cannot be safely slugged, and never more than
  `MAX_TABLES_PER_PROJECT`.

### Two very different ingest paths

**CSV needs no intermediate.** `read_csv` is built into the pinned engine and
works under the full lockdown, and `sniff_csv` returns typed columns, delimiter
and header detection — so a CSV becomes Parquet in one `COPY`, with a schema
the engine derived rather than one we guessed.

**XLSX cannot go through DuckDB at all.** `read_xlsx` lives in the `excel`
extension, which is not installed and cannot be autoloaded or fetched once the
prelude closes network access; under lockdown it fails with
`Catalog Error: … it exists in the excel extension`. So a workbook takes the
sandboxed squisq route instead, via `convertInSandbox(path, 'xlsx', 'tables')`
— the same isolated worker that produces the markdown shadow, in a second mode
that emits typed rows as NDJSON.

**Markdown is not the data path**, and it is worth being explicit about why:
squisq's `formattedNumberText` renders a percent-formatted `0.15` as `"15.0%"`,
a date serial as text, and a zero-padded `7` as `"007"`. Those are renderings
for people. squisq knows each cell's underlying value, so the data path reads
`XlsxCell.value` through `xlsxToTables`; markdown stays the FTS path.

A sheet is not a table — it is several data islands with captions, notes and
totals in the gaps — so one workbook yields **one table per island**, named
from the island's caption, or its sheet and anchor. `role=formulas` and
`role=loose` regions are excluded: useful to a reader, meaningless to a query.

### When it runs

1. **Mark** — the static index pass enrols the file and hashes it, recording a
   row in the `tabular_state` gate table (content-hash keyed, its own table:
   sharing `shadow_state` or the `doc:convert` key would let one pass's success
   permanently suppress the other's work, and an `.xlsx` wants both).
2. **Drain** — a post-pass in `ContentIndex.refresh`, back on the service side
   where `DuckRunner` lives, converts what changed. Bounded per pass; anything
   over `INLINE_MATERIALIZE_MAX_BYTES` is recorded `deferred`.
3. **Night** — `drainWorkspaceTablesAtNight` runs the same drain with the size
   ceiling and per-run cap lifted, because nobody is waiting.

The night pass runs **before** the nightly maintenance decides a project has no
tables. A project whose only tabular content is a deferred 2 GB CSV has no
tables *yet*; checking first would skip it as empty, on every night, forever.

### Discoverability

A large CSV is invisible to keyword search — the indexer marks it `trivial`, so
it has no chunks. The drain therefore writes a thin **table card** into the
shadow tree: source path, row count, column names, and a pointer to
`describe_table`. Names and shape only, never rows: rows in the text or vector
index are precisely the poisoning §10 forbids.

### Opt-out

`workspaceTablesEnabled` (default on, like `nightlyFixesEnabled`), checked
alongside the project-wide `indexingEnabled`. A project whose settings cannot
be read is **skipped**, not assumed permissive — deriving tables spends CPU and
disk, and the drain is idempotent, so the next pass retries.

## 10. What must never happen

- **Rows must never reach the model in bulk.** The entire scaling argument is
  that the gezel reads a schema and an answer. A tool that returns raw rows by
  the thousand rebuilds the ceiling this shape exists to remove.
- **Observation data must never enter the text or vector index.**
  `artifacts-indexer.ts` skips `tables/` at the directory level.
- **Retention must never run before rollups.**
- **The statement guard must never be relaxed** on the theory that the config
  lockdown covers writes. It does not; see §5.
- **A workspace table must never be treated as a stream.** It is a snapshot:
  appending to one, or partitioning it by time, would leave the corpus
  disagreeing with the file it was built from.
- **A spreadsheet's numbers must never come from its markdown rendering.**
  See §11.
