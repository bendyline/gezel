# 0009 — Observation corpora and the local query engine

Status: Accepted (2026-08)

## Context

Connectors had exactly one output shape: one markdown file per record, indexed
into a per-project FTS + vector database and read by gezels with the artifact
tools. That shape is correct for the corpora it was designed against — mail,
issues, calendar entries, wiki pages — where a record is prose a human would
read and a busy corpus is a few thousand records.

Users then asked for the sources they actually spend money on: Azure Front Door
and Application Insights logs, CDN request logs, billing exports. These are
10⁶–10⁹ rows per day, and the existing shape fails three separate ways at once:
a million inodes per binding per day; retrieval that cannot express `GROUP BY`;
and near-identical log text collapsing the vector space, which degrades
retrieval for the *other* corpora in the same project. The artifacts indexer's
`MAX_ARTIFACT_FILES = 20_000` is the point where it stops rather than the cause.

The deeper problem is that in the document shape, **corpus size and context
size are the same number**. The gezel answers questions by reading records, so
the corpus can never exceed what a model can read. No amount of tuning moves
that.

## Decision

Add a second corpus shape rather than stretching the first.

An **observation corpus** mirrors rows into Hive-partitioned Parquet under
`artifacts/data/<corpus>/tables/`, and gezels read it through
`list_tables` / `describe_table` / `query_table` — SQL in, a bounded result set
back. **The model never handles a row of the corpus.** That single inversion is
what decouples corpus size from context size and removes the ceiling.

Supporting decisions, each of which had a plausible alternative:

**The engine is the DuckDB CLI, bundled like `uv`.** Not a native Node addon
(a new ABI surface across the embedded / spawned / packaged supervisor matrix,
for no gain), and not a server — ClickHouse or Postgres would add a daemon
lifecycle to a supervisor that already has six hosting modes, and break
local-first. A subprocess also means a runaway query is a killable child rather
than a runaway allocation in the daemon's heap. Following the `uv` precedent
rather than the node/pnpm one additionally buys the runtime-download resolver,
which npm and CLI installs need since they have no Electron to unpack a bundle.

**NDJSON lands, Parquet compacts, and DuckDB does the conversion.** Writing
Parquet directly would need a second data-format dependency and a much harder
crash-safety story. Landing text and compacting later means gezel carries **no
Parquet encoder at all**, a torn append loses at most a trailing line, and
freshly-synced rows stay queryable — views union Parquet and un-compacted
NDJSON — before the night shift touches them.

**SQL with a semantic layer, not a query DSL.** Models write SQL well; a DSL
would be a second dialect nobody has trained on, and a compiler to maintain.
What makes the SQL *correct* is the table manifest: units, roles, cardinality
hints, and worked examples, rendered by `describe_table` and never injected
into the system prompt.

**One `RecordRef` is one page, not one row.** The sync engine's existing caps
count refs. Per-row refs would silently window a large page away; per page,
every existing constant works unchanged and the ceiling becomes hundreds of
millions of rows per pass.

**Reuse the sync engine rather than forking it.** `syncWithAdapter` already
took an injectable writer, so scopes, the per-scope cursor envelope, paging,
retry, and rate-limit back-off are the document path's code, unchanged. Only
the terminal write differs.

## The guard, and why the obvious one is wrong

This is the part most likely to be undone by someone reasoning from first
principles, so it is recorded with the measurements.

`DuckRunner` locks the engine's configuration before every statement. Against
the pinned DuckDB that blocks reads outside the corpus, remote URLs,
`INSTALL`, and `COPY` to an outside path, and refuses to re-widen any of it.
It does **not** block `ATTACH`: `ATTACH '<corpus>/x.db'` followed by
`CREATE TABLE` writes a real file inside an allowed directory. Verified, and
pinned as a regression test.

A leading-keyword allowlist — the guard originally planned — is also
insufficient, three ways, each verified rather than assumed:

- `WITH c AS (SELECT 1) INSERT INTO t SELECT * FROM c` **executes the insert**.
  A leading `WITH` says nothing about what follows it.
- `EXPLAIN ANALYZE INSERT INTO t VALUES (7)` **executes the insert**.
- The row-limit wrapper `SELECT * FROM (<sql>) LIMIT n` is itself an injection
  surface: `SELECT 1) ; ATTACH '/tmp/x.db' AS w; SELECT * FROM (SELECT 1`
  closes the parenthesis and smuggles two statements. Run unguarded, it created
  the file.

So the authoritative guard is **DuckDB's own parser**, reached through
`json_serialize_sql`, accepting only `error === false` and exactly one parsed
statement. It refuses everything above, and it parses without executing, so
validation itself is inert. The lexical pass in front of it exists only for
message quality — a model repairs "you cannot INSERT here" far more reliably
than "syntax error at or near".

## Consequences

- **A second shape to keep in mind.** Anyone adding a connector type now
  chooses, and the contract for the new one is
  [docs/observation-corpora.md](../observation-corpora.md).
- **Retention can destroy information.** It is the only operation in the
  subsystem that does, and it is unrecoverable because the upstream window has
  usually moved on. It therefore runs last, is opt-in, and refuses any
  partition that is not both fully rolled up and fully compacted.
- **A silently truncated part would poison every later answer**, so the
  compactor verifies row counts before publishing and keeps both files on
  mismatch.
- **Observation data is excluded from text and vector indexing** at the
  directory level, which is as much about protecting the *other* corpora as
  about saving work.
- **Two schema sources.** An authored manifest ships as gilde content; an
  inferred one is honest about being a guess. A native adapter can beat both
  when the source reports its own types — which is the main justification for
  `azure-monitor-logs` being native rather than a manifest.

## Alternatives considered

- **Stretch the document corpus** (bigger caps, smarter chunking). Does not
  address the shape mismatch: the gezel would still answer by reading records,
  so the ceiling would move, not lift.
- **Index rows into the existing SQLite index.** Row-store, and it would put
  log text next to prose in the same FTS and vector tables — the failure the
  new shape exists to avoid.
- **A hosted query service.** Breaks the local-first promise outright.
- **`chDB` / DataFusion / Polars** instead of DuckDB. chDB is heavier with a
  thin Node story; DataFusion's Node embedding is immature; Polars is
  dataframe-shaped, and SQL is the better target because models write it well.
