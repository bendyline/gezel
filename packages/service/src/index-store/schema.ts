import type { SqliteDriver } from './sqlite-driver.js';

/**
 * Index schema v1. Collection-, modality-, and metadata-aware from day one so
 * the later phases (images, source adapters, meta-boekwachter entities) fill
 * existing columns/tables rather than forcing a re-index. See the plan's
 * "Architecture generalizations".
 *
 * FTS tables are standalone (we write copies on upsert) rather than
 * external-content — simpler to keep in sync than content-sync triggers, and the
 * duplicated text is cheap relative to the vectors.
 *
 * The vector default dim is 384 (all-MiniLM-L6-v2, the existing embeddings
 * model). `vec_image` (a different model/dim) is created in Phase 5.
 *
 * `GEZEL_EMBED_DIM` overrides the text-vector dim to match a non-384
 * `GEZEL_EMBED_MODEL` (the index-bench embedding A/B). It must be set BEFORE
 * a project's index.db is created — an existing `vec_text` keeps its original
 * dim (`CREATE ... IF NOT EXISTS`), so a dim change in production means
 * rebuilding the index dbs (they're regenerable caches).
 */

export const TEXT_EMBED_DIM = Number(process.env.GEZEL_EMBED_DIM) || 384;

const BASE_DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS collections (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  root_path TEXT NOT NULL,
  label TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  collection_id TEXT NOT NULL,
  path TEXT NOT NULL,
  hash TEXT,
  size INTEGER,
  mtime_ms INTEGER,
  lang TEXT,
  kind TEXT,
  modality TEXT,
  trivial INTEGER DEFAULT 0,
  indexed_at TEXT,
  loc INTEGER,
  PRIMARY KEY (collection_id, path)
);

CREATE TABLE IF NOT EXISTS metadata (
  collection_id TEXT NOT NULL,
  path TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT
);
CREATE INDEX IF NOT EXISTS idx_metadata_path ON metadata (collection_id, path);
CREATE INDEX IF NOT EXISTS idx_metadata_key ON metadata (collection_id, key, value);

CREATE TABLE IF NOT EXISTS symbols (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  collection_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_hash TEXT,
  name TEXT NOT NULL,
  kind TEXT,
  line_start INTEGER,
  line_end INTEGER,
  signature TEXT,
  parent TEXT
);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols (collection_id, name);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols (collection_id, file_path);

-- Code dependency edges (the "roads"). One row per (importer, raw specifier);
-- dst_path is the resolved repo-relative target, NULL when external/unresolved.
-- file_hash gates incremental recompute: re-extract a file's imports only when
-- its content hash changes (same discipline as symbols/chunks).
CREATE TABLE IF NOT EXISTS imports (
  collection_id TEXT NOT NULL,
  src_path TEXT NOT NULL,
  raw_specifier TEXT NOT NULL,
  dst_path TEXT,
  file_hash TEXT,
  bindings TEXT,
  PRIMARY KEY (collection_id, src_path, raw_specifier)
);
CREATE INDEX IF NOT EXISTS idx_imports_src ON imports (collection_id, src_path);
CREATE INDEX IF NOT EXISTS idx_imports_dst ON imports (collection_id, dst_path);

-- Persisted, stable city-map layout. Districts (folders) and blocks (files)
-- keep their coordinates build-over-build so the map stays familiar; buildings
-- (symbols) are derived on the fly and not stored. removed_at tombstones a
-- deleted node (rendered as a vacant lot) until pruned; content_hash lets a
-- rename transplant an old coordinate to the new path.
CREATE TABLE IF NOT EXISTS map_layout (
  collection_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  node_kind TEXT NOT NULL,
  node_id TEXT NOT NULL,
  parent_id TEXT,
  content_hash TEXT,
  x REAL, y REAL, w REAL, h REAL,
  weight REAL,
  placed_at TEXT,
  removed_at TEXT,
  PRIMARY KEY (collection_id, domain, node_kind, node_id)
);
CREATE INDEX IF NOT EXISTS idx_map_layout_parent ON map_layout (collection_id, domain, parent_id);

CREATE TABLE IF NOT EXISTS summaries (
  content_hash TEXT PRIMARY KEY,
  collection_id TEXT,
  file_path TEXT,
  summary_md TEXT,
  tags TEXT,
  model TEXT,
  provider TEXT,
  gezel_id TEXT,
  gezel_name TEXT,
  app_version TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  collection_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  content_hash TEXT,
  kind TEXT,
  line_start INTEGER,
  line_end INTEGER,
  text TEXT
);
CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks (collection_id, file_path);

-- Enrichment gate. embedded_at set = done. embedded_at NULL = a summarize
-- attempt failed for this hash; attempts counts capped retries (the work-list
-- predicate readmits the hash while attempts < the cap) so a transient engine
-- outage no longer permanently skips a file the way the old unconditional
-- markEnriched did.
CREATE TABLE IF NOT EXISTS enrichments (
  content_hash TEXT PRIMARY KEY,
  embedded_at TEXT,
  attempts INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS image_vectors (
  chunk_id INTEGER PRIMARY KEY,
  collection_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  vec BLOB
);
CREATE INDEX IF NOT EXISTS idx_image_vectors_col ON image_vectors (collection_id);

CREATE TABLE IF NOT EXISTS entities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT,
  label TEXT,
  canonical TEXT
);
CREATE TABLE IF NOT EXISTS entity_mentions (
  entity_id INTEGER NOT NULL,
  collection_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  line INTEGER,
  region TEXT,
  confidence REAL
);
CREATE INDEX IF NOT EXISTS idx_entity_mentions ON entity_mentions (entity_id);

-- Static security findings (the security-intel substrate). Built-in pattern/
-- entropy/source-sink hits are keyed by file + file_hash (incremental, same
-- discipline as symbols/imports); opportunistic OSS-tool hits (semgrep/osv/
-- gitleaks) are whole-repo and replaced per scan, distinguished by 'source'.
-- 'fingerprint' dedupes the same logical finding across re-scans/tools.
CREATE TABLE IF NOT EXISTS security_findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  collection_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  line INTEGER,
  rule_id TEXT,
  category TEXT,
  severity TEXT,
  source TEXT,
  title TEXT,
  evidence TEXT,
  fingerprint TEXT,
  file_hash TEXT
);
CREATE INDEX IF NOT EXISTS idx_security_findings_file ON security_findings (collection_id, file_path);
CREATE INDEX IF NOT EXISTS idx_security_findings_sev ON security_findings (collection_id, severity);
CREATE INDEX IF NOT EXISTS idx_security_findings_src ON security_findings (collection_id, source);

-- User/worker lifecycle for a finding is kept separate from scanner-owned rows:
-- scans freely replace security_findings, while this survives as long as the
-- same fingerprint still exists. Once a finding disappears, the writer prunes
-- its lifecycle row so a later regression starts open again.
CREATE TABLE IF NOT EXISTS security_finding_lifecycle (
  collection_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  task_ref TEXT,
  resolved_at TEXT,
  PRIMARY KEY (collection_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_security_finding_lifecycle_task
  ON security_finding_lifecycle (collection_id, task_ref);

-- Dependency inventory derived from import specifiers + manifests/lockfiles,
-- enriched with advisories/licenses by opportunistic SCA tools. Whole-repo,
-- replaced per scan.
CREATE TABLE IF NOT EXISTS dependencies (
  collection_id TEXT NOT NULL,
  name TEXT NOT NULL,
  ecosystem TEXT NOT NULL,
  version TEXT,
  direct INTEGER DEFAULT 0,
  advisory_ids TEXT,
  max_severity TEXT,
  license TEXT,
  PRIMARY KEY (collection_id, name, ecosystem)
);
CREATE INDEX IF NOT EXISTS idx_dependencies_col ON dependencies (collection_id);

-- Per-symbol LLM one-liners, keyed by file_hash so an edit invalidates them
-- (same discipline as summaries/enrichments). A separate table rather than a
-- column on symbols because putSymbols is delete-then-insert — rows here
-- survive symbol re-extraction for an unchanged hash. Stale-hash rows are
-- pruned on write.
CREATE TABLE IF NOT EXISTS symbol_summaries (
  collection_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_hash TEXT NOT NULL,
  symbol_name TEXT NOT NULL,
  summary TEXT NOT NULL,
  model TEXT,
  provider TEXT,
  gezel_id TEXT,
  gezel_name TEXT,
  app_version TEXT,
  created_at TEXT,
  PRIMARY KEY (collection_id, file_path, file_hash, symbol_name)
);
CREATE INDEX IF NOT EXISTS idx_symbol_summaries_file
  ON symbol_summaries (collection_id, file_path, file_hash);

-- Deep-pass rollups: one row per top-level folder ("area"), plus the sentinel
-- '::project' row holding the whole-project architecture note. input_hash =
-- hash of the child file summaries that fed the rollup, so an unchanged area
-- never burns another LLM call (same discipline as enrichments).
CREATE TABLE IF NOT EXISTS area_summaries (
  collection_id TEXT NOT NULL,
  area_path TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  summary_md TEXT NOT NULL,
  model TEXT,
  provider TEXT,
  gezel_id TEXT,
  gezel_name TEXT,
  app_version TEXT,
  created_at TEXT,
  PRIMARY KEY (collection_id, area_path)
);

-- Boekwachter review pass: per-file cliffs notes + issues + 1-10 health, keyed
-- by content hash (same content-addressed discipline as summaries — rows
-- survive file deletes/renames and re-serve instantly on revert; deliberately
-- NOT pruned by deleteFile and NOT cleared by reconcileEmbedModel, reviews are
-- embedding-independent). rubric_hash = the rubric that produced the last
-- SUCCESSFUL review; a rubric/prompt change lazily re-reviews. attempt_* track
-- capped retries for non-empty-but-unparseable replies WITHOUT consuming the
-- gate; success fields and attempt fields are disjoint, so a failed re-review
-- never clobbers the last good review.
CREATE TABLE IF NOT EXISTS file_reviews (
  content_hash TEXT PRIMARY KEY,
  collection_id TEXT,
  file_path TEXT,
  rubric_hash TEXT,
  notes_md TEXT,
  issues TEXT,
  health INTEGER,
  health_reason TEXT,
  model TEXT,
  provider TEXT,
  gezel_id TEXT,
  gezel_name TEXT,
  app_version TEXT,
  reviewed_at TEXT,
  attempt_rubric_hash TEXT,
  attempts INTEGER DEFAULT 0,
  last_attempt_at TEXT
);

-- AI-shadow gate (images described by the vision model, audio transcribed by
-- STT into artifacts/shadow markdown). Same content-addressed discipline as
-- enrichments: 'ok' rows survive renames/reverts; failures retry up to a cap
-- per hash. The sidecar file is the artifact; this row is only the work gate.
CREATE TABLE IF NOT EXISTS shadow_state (
  content_hash TEXT PRIMARY KEY,
  collection_id TEXT,
  file_path TEXT,
  state TEXT,
  attempts INTEGER DEFAULT 0,
  model TEXT,
  updated_at TEXT
);

-- Embed-only gate (v11): chunks embedded WITHOUT a summarizer, so semantic
-- search works before any Boekwachter joins the roster. Deliberately a
-- separate table from enrichments — the full-enrichment pass writes that
-- gate on success, and reusing it here would consume the summary gate and
-- permanently block later summarization (a naive embed-only pass poisoned it
-- exactly that way in design review). Same content-addressed discipline as
-- shadow_state; a full enrichment supersedes rows here (the work-list also
-- checks enrichments.embedded_at).
CREATE TABLE IF NOT EXISTS embed_state (
  content_hash TEXT PRIMARY KEY,
  collection_id TEXT,
  file_path TEXT,
  embedded_at TEXT,
  attempts INTEGER DEFAULT 0
);

-- Symbol-summary retry ledger (v11): a parse or engine failure previously
-- left nothing behind, silently costing a file its per-symbol one-liners
-- until its content changed. Capped retries like every other gate; success
-- needs no row (stored symbol_summaries are the success signal).
CREATE TABLE IF NOT EXISTS symbol_summary_state (
  content_hash TEXT PRIMARY KEY,
  attempts INTEGER DEFAULT 0
);

-- Mirror of the append-only history JSONL (the audit log). kind/project/gezel/at
-- are real columns so HistoryFilter fields stay SQL-filterable; only the q text
-- goes through fts_history. INSERT OR IGNORE on the event id makes JSONL
-- backfill idempotent.
CREATE TABLE IF NOT EXISTS history_events (
  id TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  project_id TEXT,
  gezel_id TEXT,
  summary TEXT NOT NULL,
  details TEXT
);
CREATE INDEX IF NOT EXISTS idx_history_at ON history_events (collection_id, at DESC);
`;

const FTS_DDL = `
CREATE VIRTUAL TABLE IF NOT EXISTS fts_symbols
  USING fts5(name, signature, file_path UNINDEXED, kind UNINDEXED, line_start UNINDEXED, line_end UNINDEXED, symbol_id UNINDEXED, collection_id UNINDEXED);
CREATE VIRTUAL TABLE IF NOT EXISTS fts_summaries
  USING fts5(summary, file_path UNINDEXED, content_hash UNINDEXED, collection_id UNINDEXED);
CREATE VIRTUAL TABLE IF NOT EXISTS fts_docs
  USING fts5(body, file_path UNINDEXED, line_start UNINDEXED, chunk_id UNINDEXED, collection_id UNINDEXED);
CREATE VIRTUAL TABLE IF NOT EXISTS fts_metadata
  USING fts5(value, key UNINDEXED, file_path UNINDEXED, collection_id UNINDEXED);
CREATE VIRTUAL TABLE IF NOT EXISTS fts_history
  USING fts5(body, event_id UNINDEXED, collection_id UNINDEXED);
`;

// v11: embed_state table (embed-only gate — additive CREATE, no backfill).
const SCHEMA_VERSION = 11;

/**
 * Add a column to an existing table if it isn't already present. SQLite has no
 * `ADD COLUMN IF NOT EXISTS`, and the index DB is a long-lived cache that may
 * predate a column, so we introspect `PRAGMA table_info` and `ALTER` only when
 * missing. Fresh DBs already have the column from `BASE_DDL`, so this is a
 * no-op there.
 */
function addColumnIfMissing(db: SqliteDriver, table: string, column: string, decl: string): void {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
    if (cols.some((c) => c.name === column)) return;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  } catch {
    /* introspection/alter failed — non-fatal; the feature reading it degrades */
  }
}

/**
 * Create all tables idempotently. Vector tables are created only when the
 * sqlite-vec extension loaded. Returns whether FTS is available (it always is
 * with a normal sqlite build, but we probe to stay honest).
 *
 * `vectors: false` skips vector-table creation entirely — the global FTS
 * mirror (`global.db`) never stores embeddings, and giving it a `vec_text`
 * anyway meant every embed-model swap ran a pointless DROP/CREATE + gate
 * clear against a database with no vectors in it.
 */
export function applySchema(
  db: SqliteDriver,
  opts: { vectors?: boolean } = {},
): { fts: boolean; vec: boolean } {
  db.exec(BASE_DDL);

  // Additive migrations for DBs created before these columns existed (v2 → v3).
  addColumnIfMissing(db, 'files', 'loc', 'INTEGER');
  addColumnIfMissing(db, 'symbols', 'parent', 'TEXT');
  // v6 → v7: named import bindings (JSON ImportBinding[]) on dependency edges.
  addColumnIfMissing(db, 'imports', 'bindings', 'TEXT');
  // v7 → v8: capped summarize retries on the enrichment gate.
  addColumnIfMissing(db, 'enrichments', 'attempts', 'INTEGER DEFAULT 0');
  // v8 → v9: lifecycle actions require a stable identity. Older/partial
  // scanner rows may have left fingerprint null even though the column
  // existed from the first security schema.
  try {
    db.exec(`UPDATE security_findings
      SET fingerprint = CASE
        WHEN source = 'builtin' THEN rule_id || ':' || file_path || ':' || COALESCE(line, 0)
        ELSE COALESCE(source, 'builtin') || ':' || rule_id || ':' || file_path || ':' || COALESCE(line, 0)
      END
      WHERE fingerprint IS NULL OR fingerprint = ''`);
  } catch {
    /* cache migration is best-effort; rowToFinding still degrades safely */
  }

  // v9 → v10: provenance stamps on every LLM-written row ("reviewed by
  // <model>, <gezel>, gezel <version> on <date>"). No backfill — provenance
  // for pre-existing rows is genuinely unknown; renderers degrade to the
  // model-only line. Rubric/input hashes are untouched, so nothing re-reviews.
  for (const table of ['summaries', 'symbol_summaries', 'area_summaries', 'file_reviews']) {
    addColumnIfMissing(db, table, 'provider', 'TEXT');
    addColumnIfMissing(db, table, 'gezel_id', 'TEXT');
    addColumnIfMissing(db, table, 'gezel_name', 'TEXT');
    addColumnIfMissing(db, table, 'app_version', 'TEXT');
  }

  let fts = true;
  try {
    db.exec(FTS_DDL);
  } catch {
    fts = false;
  }

  let vec = false;
  if (db.vecAvailable && opts.vectors !== false) {
    // `distance_metric=cosine` matches vec_mem: vectors are L2-normalized so
    // the RANKING is identical to the L2 default, but the reported distance
    // scale is not — declaring it keeps any future distance→similarity
    // conversion from being quietly wrong. `IF NOT EXISTS` means pre-existing
    // tables keep their original metric until the next re-embed migration
    // recreates them; fine, because nothing converts vec_text distances.
    try {
      db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS vec_text USING vec0(embedding float[${TEXT_EMBED_DIM}] distance_metric=cosine);`,
      );
      vec = true;
    } catch {
      // Older sqlite-vec builds reject distance_metric — fall back to the
      // default (L2), which ranks identically on normalized vectors.
      try {
        db.exec(
          `CREATE VIRTUAL TABLE IF NOT EXISTS vec_text USING vec0(embedding float[${TEXT_EMBED_DIM}]);`,
        );
        vec = true;
      } catch {
        vec = false;
      }
    }
  }

  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
    'schema_version',
    String(SCHEMA_VERSION),
  );
  return { fts, vec };
}
