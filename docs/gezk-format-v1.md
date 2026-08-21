# `.gezk` v1 — Knowledge Catalog Format & Scale Architecture

Status: Frozen for implementation (2026-08). Companion to
[knowledge-catalogs.md](knowledge-catalogs.md), which owns the product
architecture (trust, storage tiers, installation, UX); this document owns the
container format, index schema, embedding/chunking profiles, and the scale
design that lets one runtime serve a 200-document personal reference and a
2,000,000-document Wikipedia-class corpus within the same latency gates
(≤250 ms p95 proactive retrieval, ≤750 ms p95 explicit search, warm).

`.gezk` means **Gezel Knowledge** (the extension family sibling of
`.gezmodel`). It is a standard ZIP/ZIP64 so ordinary archival tools can
inspect it.

## Decisions vs. the draft (changelog)

| # | Draft said | Frozen decision |
|---|---|---|
| 1 | profile `gezel-minilm-l6-v2@1`, float32 vectors | Public profile **`gezel-multilingual-e5-small@1`**; local-build default **`gezel-bge-small-en-v1.5@1`**. Encoding **`bit384+int8` two-stage** — float32 and int8-only both fail the latency math at 2M docs (§2). |
| 2 | benchmark quantization "before production" | Quantization decided now, in-format, with frozen compiler-side formulas — no dependence on `vec_quantize_*` extension semantics (§2). |
| 3 | `gezel-markdown-chunks@1` (tokens 420/64) | Knowledge uses **`gezel-markdown-chunks@2`** (token-based 420/64, structural heading path, contextual embed header). `@1` retroactively names today's project 4000-char/400-char chunker; project indexes do not migrate (§5). |
| 4 | router "selects likely shards" (deferred) | Shards target **200,000 chunks** (~35 for 2M docs); **16 k-means centroids per full shard**, max-pooled scoring; **top-S globally across catalogs**: S=3 proactive, S=6 explicit (§3). |
| 5 | small catalog "may" embed in router.db | Formalized: `shards` row with `path='index/router.db'`; one reader code path (§3.5). |
| 6 | `body_codec` unspecified | **brotli quality 5** (`'br'`), `'none'` under 512 bytes; codec set frozen per formatVersion (§6.1). |
| 7 | FTS tokenizer unspecified | **`unicode61 remove_diacritics 2`** everywhere; no stemmer (language-neutral, matches the multilingual profile). `fts_chunks` is external-content over `chunks` (§6.2). |
| 8 | manifest sketch | Adds full profile + chunking objects, router stats, toolchain fingerprint, **RFC 8785 (JCS)** signature canonicalization, exact id and `knowledge://` grammars (§7, §8). |
| 9 | query concurrency unstated | node:sqlite is synchronous ⇒ **one dedicated knowledge worker thread** owns all catalog connections; shard scans run sequentially inside it (§9). |
| 10 | knowledge merge weight "~380" | **370** — 380 belongs to `handboek`; 370 sits between handboek (380) and memory (360). |
| 11 | "backport embedding-profile identity" (audit C5) | Landed: `embedProfileId()` in embed-core, stamped through the existing `meta.embed_model` / `mem_meta` keys with unchanged reconcile-on-mismatch semantics (§10). |
| 12 | "builds are deterministic" | Scoped honestly: byte-identical **per toolchain fingerprint**; ONNX CPU inference is not bit-stable across machines, so the embed content-hash cache is the reproducibility authority (§11). |
| 13 | TOC implicit | **The table of contents is a format requirement**: the compiler rejects a catalog with zero `topics` rows; the Knowledge browser renders the tree with no per-catalog code (§6.1). |

## 1. Scale model (planning constants)

2,000,000 documents; Wikipedia-shaped mean ~800 tokens/article; 420/64
chunking ⇒ ~3.5 chunks/doc ⇒ **7,000,000 chunks** planning number. Per-chunk
vector bytes at 384-dim: float32 1,536 B / int8 384 B / bit 48 B.
Minimum-supported CPU effective exact-scan throughput assumed **0.5–1 GB/s**
(validated by the Phase-0 large-shard benchmark).

## 2. Vector encoding: `bit384+int8` two-stage

Target: one shard scan ≤ ~15–25 ms warm.

- **float32**: 7M × 1,536 B = 10.7 GB of vectors. Not shippable or scannable.
- **int8-only**: shards small enough to scan in budget (7.5–25 MB ⇒ 20k–65k
  vectors) mean 110–350 shards; the routing-recall gate then forces S≈10–12
  scans ≈ 240 ms — the proactive budget is gone. Big int8 shards (200k × 384 B
  = 77 MB) cost 77–154 ms each — also gone.
- **bit + int8**: the hamming stage over a 200k-chunk shard touches 200k ×
  48 B = **9.6 MB ⇒ 10–19 ms**, so shards stay big and few (~35), and S=3 is a
  meaningful topical slice. Stage 2 reranks the hamming top-K against int8
  vectors fetched by rowid — ≤512 point lookups + JS dot ≈ **1–2 ms**.
  Published binary-quantization results on normalized 384-dim embeddings at
  20–50× rerank oversampling recover ≥~95% of exact recall@10; with
  `K = min(512, max(128, 8·finalK))` and finalK=24 we oversample ~21×. K and S
  are runtime knobs, not format constants; the pilot's recall gate validates.

Frozen formulas (computed in compiler TypeScript; the sqlite-vec
`vec_quantize_*` functions are deliberately unused so extension-internal
semantics can never drift the format):

- **int8**: `q[i] = clamp(round(x[i] * 127), -127, 127)` (symmetric; −128
  never produced). Dequant `x̂[i] = q[i] / 127`.
  Manifest: `quantization.int8 = { method: "symmetric-linear", scale: 127 }`.
- **binary**: `bit[i] = x[i] > 0 ? 1 : 0` (exact 0.0 → 0), packed
  **LSB-first** (byte `j` bit `k` = dimension `j*8+k`), 48-byte blob. Both
  insert and query bind through `vec_bit(?)` using the same TS packer.
  Manifest: `quantization.binary = { method: "sign", threshold: 0, packing: "lsb-first" }`.
- **Rerank score** = `dot(float32 unit query, x̂ passage)` — the query is not
  quantized; passages were unit vectors, so dot ≈ cosine.

Future encodings (int8-only, float32, matryoshka) are **new profile ids**;
readers hard-reject an unknown `vectorEncoding` with the
disabled-with-reason path — never a silent fallback.

## 3. Shards and routing

### 3.1 Sizing

- Target **200,000 chunks/shard**, hard cap 250,000, balance ±10%. 7M chunks
  ⇒ ~35 shards. Per-shard bytes ≈ 0.7 GB total, of which the vec0 bit region —
  the only part a scan touches — is ~13 MB.
- A document's chunks never split across shards (simplifies dedupe, per-doc
  caps, and hydration).

### 3.2 Topic-affinity assignment

Documents sorted by `(topicPathKey, documentId)` (`topicPathKey` = the
`/`-joined topic id path), greedy-filled to the target: shards come out
topically coherent, which is what makes centroids meaningful. Oversized topics
span consecutive shards; small topics share. `documents.shard_id` records the
assignment.

### 3.3 Centroids

`k = clamp(ceil(chunkCount / 12500), 1, 32)` per shard (16 for a full shard;
~560 rows ≈ 0.9 MB per 2M-doc catalog — a sub-millisecond exact scan).
Seeded k-means++ (seed = low 64 bits of `SHA-256(catalogId \0 shardId)`) over
a deterministic stride sample of ≤65,536 chunk vectors in chunk-id order;
≤25 iterations or movement < 1e-4; centroids L2-normalized, stored float32 LE.
Centroids are always emitted, single-shard catalogs included (the per-user
cross-catalog router copies them at enable time).

### 3.4 Query routing

Embed once per active profile → score every centroid of every active catalog
(cosine) → shard score = **max over its centroids** → pick **top-S shards
globally across catalogs** (the global budget is what stops 8 active catalogs
multiplying cost): **S=3 proactive, S=6 explicit** → scan sequentially → fuse.

Catalog-wide `fts_documents` (title/summary/alias) always runs regardless of
routing — proactive over the top-2 routed catalogs, explicit over all active —
so exact-title recall never depends on vector routing. This de-risks the
draft's gate (routing recall within 2pp of scanning every shard, measured at
the 100k pilot): routing only gates the semantic body arms.

Explicit `catalogs:`/topic filters restrict the centroid pool before top-S;
filters never widen S. The router is a performance hint, not an authority
boundary.

### 3.5 Small-catalog degeneracy

Total chunks ≤ 200,000 ⇒ the compiler embeds the single shard **in
router.db** (`shards` row `(0, 'index/router.db', …)`, `index/shards/`
absent). The reader resolves `shards.path` uniformly and opens one connection
per distinct resolved path — the embedded case is the same code with a path
that happens to equal router.db's. Catalogs with ≤ S shards skip centroid
scoring. At ~700 chunks the rerank is exhaustive (K ≥ chunk count) ⇒ exact
int8 quality; the query is embed-dominated.

## 4. Embedding profiles

The profile registry lives in `packages/core` (compiler and reader import the
one source). One profile per catalog version — never dual; a new profile is a
new catalog version, and the immutable-version + registry-pointer machinery
handles the transition. Two profiles are registered at freeze:

**`gezel-multilingual-e5-small@1`** — the public Qualla profile:

```jsonc
{
  "id": "gezel-multilingual-e5-small@1",
  "model": {
    "repo": "Xenova/multilingual-e5-small",
    "revision": "<HF commit hash — captured when Phase 0 lands>",
    "onnxDigest": "sha256:<model.onnx digest>"
  },
  "tokenizer": { "kind": "sentencepiece-xlmr", "digest": "sha256:<tokenizer.json digest>" },
  "pooling": "mean",
  "normalized": true,
  "dimensions": 384,
  "maxTokens": 512,
  "queryInstruction": "query: ",
  "passageInstruction": "passage: ",
  "vectorEncoding": "bit384+int8",
  "distance": { "stage1": "hamming", "stage2": "cosine" },
  "quantization": {
    "int8":   { "method": "symmetric-linear", "scale": 127 },
    "binary": { "method": "sign", "threshold": 0, "packing": "lsb-first" }
  }
}
```

**`gezel-bge-small-en-v1.5@1`** — the local-build default (matches gezel's
shipped embedder, so a locally built catalog searches with no second
pipeline): same shape with `repo: "Xenova/bge-small-en-v1.5"`,
`queryInstruction: "Represent this sentence for searching relevant passages: "`
(trailing space included), `passageInstruction: ""`.

Search embeds a query once per distinct **active** profile and reuses the
vector across every catalog/shard with that profile. A second resident
pipeline (~130 MB) loads only while a non-default-profile catalog is active.

## 5. Chunking profile `gezel-markdown-chunks@2`

```jsonc
{
  "id": "gezel-markdown-chunks@2",
  "unit": "tokens",
  "tokenizer": "profile",
  "targetTokens": 420,
  "overlapTokens": 64,
  "contextHeader": { "maxTokens": 64 }
}
```

- Deterministic splitter: normalize (LF, NFC) → blocks with line spans (the
  pure functions lifted from the project chunker, `countTokens` injected) →
  heading-aware sections → pack to 420 tokens; oversize blocks split at
  sentence then hard token boundaries; overlap = trailing complete
  sentences/blocks ≤ 64 tokens. Counts exclude special tokens.
- **Embed input** = `title + "\n" + headingPath.join(" > ") + "\n" + chunkText`
  with the header truncated to ≤64 tokens ⇒ 486 + specials ≤ 512. This fixes
  the silent-truncation class by construction (today's 4000-char project
  chunks ≈ 1000 tokens overflow the 512-token window) and makes pronoun-heavy
  encyclopedia chunks referentially resolvable.
- Per chunk: `heading_path` (JSON array, root→nearest, depth ≤6, title-H1
  excluded when equal to the document title), `heading_text` (`" > "`-joined),
  `ordinal` (0-based per document), line spans, `token_count`,
  `content_hash` (SHA-256 hex of chunk text), and
  **`chunk_uid`** = lowercase hex of the first 16 bytes of
  `SHA-256(utf8(documentId) || 0x00 || utf8(decimal ordinal) || 0x00 || SHA-256(utf8(chunkText))[32 raw bytes])`.
- Today's project chunker is retroactively `gezel-markdown-chunks@1` (chars
  4000/400). **Project indexes do not migrate**; both sides import one
  parameterized chunker module.

## 6. Container layout and DDL

```text
physics-en-2026.08.gezk
├── manifest.json
├── README.md
├── LICENSES/
│   ├── catalog.txt
│   └── source-notices.json
├── index/
│   ├── router.db
│   └── shards/            (absent when embedded)
│       ├── 000.db
│       └── 001.db
└── sources/               (optional, small author-built catalogs only)
```

Both databases are built with `PRAGMA page_size=8192`,
`PRAGMA application_id=0x47455A4B` ('GEZK'), `PRAGMA user_version=1`
(= indexSchemaVersion), then `VACUUM INTO` the shipped file with
`journal_mode=DELETE` — no WAL sidecars in the artifact.

### 6.1 `index/router.db`

```sql
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
-- format_version, index_schema_version, catalog_id, catalog_version,
-- embedding_profile_json, chunking_profile_json, created_at, toolchain_json

CREATE TABLE topics(
  id TEXT PRIMARY KEY, parent_id TEXT, name TEXT NOT NULL,
  description TEXT, sort_key TEXT NOT NULL, document_count INTEGER NOT NULL
);
-- ≥1 row REQUIRED: the topics tree is the catalog's shipped table of
-- contents. The compiler rejects a catalog without one (flat corpora get a
-- single root topic); the Knowledge browser renders it as the nav rail.

CREATE TABLE documents(
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL, slug TEXT NOT NULL, summary TEXT,
  language TEXT NOT NULL, topic_id TEXT NOT NULL REFERENCES topics(id),
  shard_id INTEGER NOT NULL,
  chunk_count INTEGER NOT NULL,
  source_url TEXT, source_revision TEXT, source_updated_at TEXT,
  attribution_json TEXT,
  body_codec TEXT NOT NULL CHECK (body_codec IN ('none','br')),
  body_blob BLOB NOT NULL
);
CREATE INDEX documents_topic ON documents(topic_id, slug);
CREATE INDEX documents_shard ON documents(shard_id);

CREATE TABLE aliases(alias TEXT NOT NULL, document_id TEXT NOT NULL,
  PRIMARY KEY (alias, document_id)) WITHOUT ROWID;

CREATE TABLE shards(
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL,            -- 'index/shards/000.db' or 'index/router.db'
  chunk_count INTEGER NOT NULL, document_count INTEGER NOT NULL,
  topic_ids_json TEXT NOT NULL, centroid_count INTEGER NOT NULL,
  bytes INTEGER NOT NULL
);

CREATE TABLE route_centroids(
  id INTEGER PRIMARY KEY,
  shard_id INTEGER NOT NULL REFERENCES shards(id),
  embedding BLOB NOT NULL,       -- float32[dim] LE, L2-normalized
  weight INTEGER NOT NULL        -- chunks assigned to this centroid
);
CREATE INDEX route_centroids_shard ON route_centroids(shard_id);

CREATE VIRTUAL TABLE fts_documents USING fts5(
  title, summary, aliases, document_id UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3'
);
```

`body_codec = 'br'` is Node `zlib.brotliCompressSync` quality 5,
`BROTLI_MODE_TEXT`; bodies < 512 bytes ship `'none'`. (zstd rejected:
node-native only since 23.8, no decisive ratio win at article sizes; the codec
set is frozen per formatVersion.)

### 6.2 Shard databases

```sql
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
-- echoes catalog_id, catalog_version, shard_id, format_version,
-- index_schema_version, embedding_profile_id, chunking_profile_id,
-- chunk_count — the reader cross-checks these against router + manifest,
-- which catches shard-file mix-ups.

CREATE TABLE chunks(
  id INTEGER PRIMARY KEY,        -- shard-local 1..n, order = (document_id, ordinal)
  chunk_uid TEXT NOT NULL,
  document_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  title TEXT NOT NULL,           -- denormalized document title
  heading_path TEXT NOT NULL,    -- JSON array
  heading_text TEXT NOT NULL,
  line_start INTEGER NOT NULL, line_end INTEGER NOT NULL,
  token_count INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  text TEXT NOT NULL
);
CREATE UNIQUE INDEX chunks_uid ON chunks(chunk_uid);
CREATE INDEX chunks_document ON chunks(document_id, ordinal);

CREATE VIRTUAL TABLE fts_chunks USING fts5(
  title, heading_text, text,
  content = 'chunks', content_rowid = 'id',   -- external content: text stored once
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE VIRTUAL TABLE vec_chunks USING vec0(
  chunk_id INTEGER PRIMARY KEY,  -- == chunks.id; bind as BigInt (vec0 requirement)
  embedding bit[384],            -- implicit hamming
  chunk_size=1024
);

CREATE TABLE chunk_vectors_int8(
  chunk_id INTEGER PRIMARY KEY,  -- == chunks.id
  v BLOB NOT NULL                -- 384 signed bytes (§2)
);
```

Int8 rerank vectors live in a **plain rowid table**, not a vec0 auxiliary
column: zero behavioral uncertainty, `quick_check`-covered, keeps the vec0
region minimal (only the ~13 MB the hamming scan touches), and 512 point
lookups cost ~1 ms.

**Rowid alignment invariant**:
`chunks.id == vec_chunks.chunk_id == chunk_vectors_int8.chunk_id == fts_chunks.rowid`.

### 6.3 Reader contract

`openCatalogDatabase(absPath)` (packages/knowledge — NOT the project index
driver, whose mkdir/WAL/quarantine behaviors are all wrong for immutable
signed artifacts): `new DatabaseSync('file:<encoded>?immutable=1',
{ readOnly: true })` → load the vendored sqlite-vec extension → check
`application_id`, `user_version`, meta echo vs manifest →
`PRAGMA mmap_size=536870912; PRAGMA cache_size=-8192`. Windows paths must be
file-URI-encoded. Incompatibility returns a typed disabled-with-reason value;
the reader never migrates, repairs, or rewrites a publisher's bytes.

Verification (install + first shared mount): per-file SHA-256 is authoritative
(covers vec0 shadow-table content, which `quick_check` cannot semantically
validate — though shadow tables are real b-trees, so `quick_check` still
catches structural corruption). Then per DB: `PRAGMA quick_check`; per shard:
`count(vec_chunks) == count(chunks) == count(chunk_vectors_int8)` and one
embedder-free **self-KNN smoke** — read chunk 1's bit blob, query `k=1`,
expect rowid 1 (proves the extension parses this file's vec blobs). Manifest
`smokeQueries` run against `fts_documents` (also embedder-free); semantic
smoke runs only when the runtime profile matches.

## 7. Manifest

The draft's manifest with these replacements/additions:

```jsonc
{
  // draft fields unchanged, except:
  "embedding": { /* full profile object, §4 */ },
  "chunking":  { /* full chunking profile object, §5 */ },
  "router": {
    "shardTargetChunks": 200000,
    "shards": [ { "id": 0, "path": "index/shards/000.db", "chunks": 199481,
                  "documents": 57210, "centroids": 16, "sha256": "<64hex>" } ],
    "totalCentroids": 560
  },
  "counts": { "documents": 2000000, "chunks": 7000000, "shards": 35 },
  "toolchain": {
    "compiler": "@bendyline/gezel-knowledge@<x.y.z>",
    "node": "24.x", "sqlite": "<lib version>", "sqliteVec": "0.1.9",
    "onnxruntime": "<x.y.z>", "platform": "win32-x64",
    "modelDigest": "sha256:<...>", "tokenizerDigest": "sha256:<...>"
  },
  "signature": {
    "algorithm": "ed25519", "keyId": "qualla-knowledge-1",
    "canonicalization": "rfc8785",
    "value": "<base64 over the JCS-canonical manifest with `signature` removed>"
  }
}
```

**Id grammars (frozen):** `publisherId`/`catalogId`/`topicId` are DNS-label
style: `[a-z0-9]`, optionally followed by `([a-z0-9-]{0,62}[a-z0-9])?`.
`documentId`: 1–256 Unicode
scalars, NFC, no controls, no leading/trailing whitespace; Markdown adapter =
normalized relative path sans extension; Wikipedia = decimal curid string.
`chunk_uid`: exactly 32 lowercase hex.

## 8. `knowledge://` URI (exact grammar)

```
knowledge-uri   = "knowledge://" catalog-id "/" enc-document-id [ "#" fragment ]
enc-document-id = seg *( "/" seg )                 ; ≤ 512 chars encoded
seg             = 1*( unreserved / pct-encoded )
fragment        = ("chunk=" 32HEXDIG) / ("line=" 1*DIGIT ["-" 1*DIGIT])
```

UTF-8 percent-encode every byte outside unreserved ∪ `/`. No publisher in the
URI; therefore the user registry **rejects enabling two catalogs with the same
`catalogId` from different publishers** — collision handled at enable time.

## 9. Runtime concurrency and latency budget

One dedicated **knowledge worker thread** owns every catalog SQLite
connection (node:sqlite is synchronous — a scan burst must never stall the
daemon loop); shard scans run sequentially inside it (bandwidth-bound, and the
math fits); LRU cap 32 open shard connections across catalogs. SearchService
posts to the worker under the existing 600 ms per-arm timeout, one pool task
per catalog for timeout isolation.

Warm budget at 2M docs: embed 10–20 ms; centroid scoring <2 ms; catalog
doc-FTS 3–10 ms; per shard bit-KNN 10–19 ms + int8 rerank 1–2 ms (+ chunk-FTS
5–12 ms, explicit only); fusion + hydration 3–10 ms. Totals: **proactive S=3
p50 ~50–100 ms, p95 ~200 ms ≤ 250 ✓; explicit S=6 p50 ~120–240 ms, p95
~450 ms ≤ 750 ✓.** Fusion = weighted RRF (vector 1.0 / shard-FTS 0.8 /
doc-FTS 0.6, k=60), dedupe by document (≤3 chunks/doc), then the per-mode
ceilings from the product doc. Multiple catalogs share the global S budget.
Cold start adds one ~13 MB read per routed shard; mount-time smoke queries
pre-warm the router.

Empirically validated (2026-08-20, Windows 18-core workstation, sqlite-vec
0.1.9): a full 200,000-row `bit[384]` shard answered k=192 KNN in **19.6 ms
median** warm, with the int8 rerank at **5.8 ms** — inside the budget above.
Rerun via `GEZK_BENCH=1` on
`packages/knowledge/src/bench/large-shard.bench.test.ts`; the plan calls for
one confirmation run on the slowest supported CI runner.

Merge weight: `MERGE_WEIGHTS.knowledge = 370` (below handboek 380, above
memory 360). Provisional relevance mapping for the calibrated scale:
`clamp01((cosine − 0.30) / 0.50)`, tuned in the Phase-4 evals.

## 10. Embedding-profile identity in project indexes (C5)

`embedProfileId()` in `packages/service/src/memory/embed-core.ts`:

```
<modelId>|d<dim>|mean|norm|q:<sha256(queryInstruction)[0..8)>|p:<sha256(passageInstruction)[0..8)>
```

Stamped through the existing `meta.embed_model` (content index) and
`mem_meta` (memory) keys with unchanged reconcile-on-mismatch semantics.
Pre-profile bare-model-id stamps mismatch once and trigger the
already-supported drop-and-re-embed; dim/pooling/instruction changes now
correctly invalidate vectors.

## 11. Determinism and reproducibility

- **Promise**: identical inputs + identical toolchain fingerprint (§7) ⇒
  byte-identical `.gezk`. Across toolchains, logical equivalence only — ONNX
  CPU inference is not bit-stable across SIMD paths/thread configs, so the
  compiler's persistent content-hash→vector cache is the reproducibility
  authority, and the build report records an aggregate vector digest.
- Deterministic everything else: sorted `(topicPathKey, documentId)`
  processing order; content-derived chunk ids; seeded k-means; no wall-clock
  values unless supplied (`createdAt` is an input); SQLite via fixed PRAGMAs +
  `VACUUM INTO`; ZIP entries sorted by path bytes, deflate level 9 fixed
  strategy, timestamps fixed `2000-01-01T00:00:00Z`, mode 0644, UTF-8 names,
  no extra fields except ZIP64 where required.
- Signature: Ed25519 over the RFC 8785 canonical manifest minus `signature`;
  the archive-level SHA-256 lives in the separately signed registry record.
