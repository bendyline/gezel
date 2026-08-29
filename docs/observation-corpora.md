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

## 10. What must never happen

- **Rows must never reach the model in bulk.** The entire scaling argument is
  that the gezel reads a schema and an answer. A tool that returns raw rows by
  the thousand rebuilds the ceiling this shape exists to remove.
- **Observation data must never enter the text or vector index.**
  `artifacts-indexer.ts` skips `tables/` at the directory level.
- **Retention must never run before rollups.**
- **The statement guard must never be relaxed** on the theory that the config
  lockdown covers writes. It does not; see §5.
