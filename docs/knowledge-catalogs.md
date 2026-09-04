# Knowledge catalogs

Status: Accepted architecture (2026-08). The container format, index schema,
embedding/chunking profiles, and scale design (sharding, routing, vector
encoding, latency budgets) are **frozen separately** in
[gezk-format.md](gezk-format.md) and the public specification in bendyline/gezk, which supersede this document's
embedding/schema sketches where they differ — notably: the extension is
`.gezk` (sibling of `.gezmodel`); the public profile is
`gezel-multilingual-e5-small@1` with a `bit384+int8` two-stage encoding (not
MiniLM/float32); the chunking profile is `gezel-markdown-chunks@2`; the
knowledge merge weight is 370; and every catalog must ship a topics table of
contents.

Implementation state (2026-08-20): Phases 0–2 are landed — the
`@bendyline/gezel-knowledge` package ships the compiler, verified archive
reader, read-only two-stage retrieval handle, deep validator, Markdown
adapter, profile registry, profile-driven embedder, and RFC 8785 Ed25519
manifest signing; `gezel knowledge init/build/validate/inspect/search` works
entirely offline. The daemon owns the private install tier
(`/api/knowledge/*`, resumable downloads, quarantine-with-reason, the
knowledge worker thread, and the explicit `knowledge` arm in unified/omni
search with `knowledge://` citations through `read_document`), and the
machine broker serves `machine-knowledge-assets`-scoped
ensure/status/inventory/reclaim of signed coordinates at
`/v1/remote/manage/knowledge/*` (archives resolved broker-side from
`GEZEL_KNOWLEDGE_REGISTRY_DIR` until the Phase-6 signed CDN registry). The
Knowledge UI (Phase 3) is landed: Settings → Knowledge (install from file
path/URL/native picker, enable/disable, quarantine reasons, remove with
confirmation), the conditional sidebar Knowledge area (appears exactly at
registered-count ≥ 1), the three-pane browser (catalog + topic rail, paged
document directory, squisq-rendered article with license/source/citation
provenance, Copy citation, Ask a gezel), titlebar-search deep links via the
open-knowledge intent, and the per-project scope row (inherit / selected /
off) in Project Settings. Proactive RAG (Phase 4) is on: `knowledge` rides
`ALL_SOURCES` (last, so project evidence leads every diversify round), the
per-mode ceilings are enforced in project-retrieval (Lean = citations only;
Balanced ≤2 chunks within 25% of the turn budget; Deep ≤4 within 35%;
injection floor 120/370), every injected chunk carries its provenance line
(`[knowledge] <uri> — <title> · <catalog>@<version>`), the untrusted-evidence
header names reference catalogs explicitly, telemetry records citation
coordinates (never text), and craftbook steps can scope retrieval to
`sources: ['knowledge']`. The invariants are CI-guarded
(project-retrieval.test.ts + the knowledge-routes integration test), and the
`knowledge-bench` eval measures the empirical gates with the daemon's real
embedder — first run (bge-small-en-v1.5, 2026-08-20): paraphrased-query
R@1 0.75 / R@5 1.00 / MRR 0.88, warm explicit search p50 8 ms / p95 22 ms
against the 750 ms gate.

Phases 5–6 (2026-08-25): the Qualla production pipeline is landed in
`qualla-internal` — `build-knowledge` streams the enwiki dump directly
(input adapter A), classifies against a 20-domain versioned taxonomy
(P31 seeds → description rules → categories → title patterns →
coordinates/general fallbacks, rules-hash stamped into the catalog
version), converts wikitext with the knowledge pre-pass (simple tables →
GFM, lead-infobox scalar fields → a "Key facts" block, entity decoding),
compiles per-domain `.gezk` catalogs with the public
`gezel-multilingual-e5-small@1` profile, and is restartable at
article/spool/catalog boundaries (checkpointed spools + the append-only
content-hash embed cache as the reproducibility authority — a kill -9
mid-embed resumed to a byte-identical release, verified by archive
sha256). `sign-knowledge-release` signs releases with the offline Ed25519
key (generate/rotate via `--generate-key`; keyId-indexed trust anchors),
re-hashes every archive, self-verifies against the public key, and stages
the CDN tree: immutable `_k/catalogs/<id>/<version>/*.gezk`
plus the RFC 8785-signed `_k/registry/index.json`, uploaded
catalogs-first/registry-LAST by the `_k` block in qualla's
sync-to-azure scripts (which re-verify every archive against the signed
contentDigest before publishing; procedure + withdrawal runbook in
qualla's RUNBOOK §6.6). The signed chain is proven end-to-end in-repo
style: registry verification (`verifyRegistryIndex`) accepts the release
and rejects tampering, and a live daemon installs a signed catalog via
URL + registry `contentDigest`, refusing a wrong digest.

100k-pilot results (2026-08-26): 100,000 articles → 20 catalogs,
1,064,599 chunks, 1.67 GB of archives (geography 452 MB, general 360 MB,
people 303 MB — the sizes that fixed archive hosting on qualla.com, never
the Pages-backed gezelgilde.com), compiled in 17.7 h at an effective
16.7 chunks/s on a single CPU embed pipeline — which makes the Phase-7
worker-pool parallelization a prerequisite, not an optimization (~7M
chunks ≈ 5 days single-pipeline). Classifier: 65% high / 13% medium /
22% low confidence, the low tier being exactly the general+coordinates
fallbacks; the 19% general bucket is the pre-production taxonomy review
target. Routing recall, measured on a 9-shard rebuild of geography
(36k-chunk shards, 3 centroids each): S=3 59.7% / S=6 84.7% recall@5 vs
scan-all (random baselines 33%/67%), with the home shard ranked first by
centroids for only 26% of queries. Root cause is content, not format:
the pilot emits a FLAT topic tree per domain, so the topic-affinity
shard fill degenerates to documentId order and shards are page-age
slices rather than topical clusters — centroids have nothing to
separate. The "within 2pp of scan-all" gate is therefore conditional on
sub-topicking the large domains (geography by country/region, people by
era/occupation) before the Phase-7 full build; until then the doc-FTS
arm and the S knob carry exact-name and explicit-search recall, and
single-catalog scan-all stays affordable at ≤10 shards.

## Executive decision

A **knowledge catalog** is a versioned, read-only body of reference material that
Gezel can search, cite, browse, and use as one bounded source in proactive indexed
context. It is distributed as a standard ZIP with the `.gezk` extension and
installed into either Gezel's shared machine asset store or the current user's
private Gezel home.

The important boundary is logical, not physical: a catalog may contain one or more
finished SQLite/sqlite-vec shards. Small catalogs built from a folder of Markdown
normally contain one database; Wikipedia-scale catalogs need an internal router
and bounded shards so a query does not scan millions of vectors. The runtime
treats both layouts as one catalog.

Knowledge catalogs are:

- read-only reference data, not projects, memories, shared documents, plugins, or
  a source of instructions;
- available to the unified `search` tool and proactive retrieval under an explicit
  `knowledge` source;
- stored once per device when it is trusted public content, or privately for one
  user when it is local/private content;
- enabled per user, with an optional per-project selection;
- browsable in a top-level Knowledge area once at least one is installed; and
- buildable offline with the Gezel CLI, using the same compiler Qualla uses for
  published Wikipedia catalogs.

Public, redownloadable catalogs pinned by the shipped gilde content (the
Bendyline releases on Hugging Face) default to the **shared machine
asset store**, alongside the existing shared model-asset concept. Locally
compiled, private, third-party, or unsigned catalogs default to the **per-user
knowledge store**. Activation, project selection, routing, browsing, search, and
RAG always remain private to the user's product daemon.

This requires one deliberate service-boundary extension: the machine engine broker
also becomes the narrow installer-owned publisher of trusted immutable knowledge
bytes. It may resolve a trusted coordinate (through its own gilde pin, an operator
drop directory, or an optional signed registry), download, verify, stage,
publish, inventory, and stream progress. It must never receive a search
query, prompt, project/session/gezel id, enabled-catalog list, or arbitrary user
path, and it must not expose knowledge search APIs. Before implementation, this
boundary and its credential scope must be recorded in `docs/service-boundaries.md`
(or a dedicated ADR); it is not permission to turn the broker into a product
daemon.

## Why this is a separate substrate

Gezel's project `index.db` is a mutable, regenerable cache with workspace-only
tables, schema migrations, and configurable embedding dimensions. A published
catalog is an immutable artifact that must still open years later. Copying a
project database into a ZIP would couple public catalogs to internal schema
version 10, permit accidental writes on open, and fail whenever the query embedder
differs from the one that built the vectors.

Knowledge therefore gets a small, independently versioned read-only schema and an
exact embedding profile. It reuses the existing chunking, embedding, hybrid
ranking, RAG budgeting, download, ZIP-safety, and staged-publication concepts, but
does not reuse `applySchema()` or mutate a project's database.

## System shape

```text
Markdown folder                     Wikipedia + Wikidata dumps
      |                                      |
      | CLI document adapter                 | Qualla streaming adapter
      `------------------+-------------------'
                         v
             @bendyline/gezel-knowledge
        normalize -> chunk -> embed -> FTS/vec
                         |
                         v
                 reproducible .gezk ZIP
                         |
             +-----------+-------------+
             |                         |
       local import          Hugging Face (gilde-pinned)
             |                         |
             v                         v
     per-user catalog store      machine asset broker
                                verify -> stage -> publish
                                           |
                                           v
                                shared read-only catalog store
             |                             |
             `--------------+--------------'
                            v
                 per-user KnowledgeManager
        mount -> re-verify -> smoke-test -> route
                            |
                +-----------+-------------+
                |                         |
          SearchService             Knowledge browser
                |
          omni search + proactive indexed context
```

## Container format: `.gezk`

`.gezk` is an **open format** specified in
[bendyline/gezk](https://github.com/bendyline/gezk) (version 0.5, preliminary
until 1.0); [gezk-format.md](gezk-format.md) maps it onto this repository and
[ADR 0012](decisions/0012-gezk-open-format.md) records why it was opened.
What this document needs from it:

- A catalog is a ZIP whose first entry is the stored `mimetype` magic
  (`application/vnd.gezk+zip`), followed by `manifest.json`, `README.md`,
  `LICENSES/catalog.txt`, `index/router.db` (topics, document directory,
  brotli bodies, routing centroids, document FTS) and, for large catalogs,
  `index/shards/NNN.db` (chunks, chunk FTS, sign-bit and int8 vectors in
  plain BLOB tables). Every entry is stored uncompressed. Nothing beyond stock
  SQLite with FTS5 reads it — sqlite-vec is not part of the format.
- The manifest (`kind: gezk-catalog`, `formatVersion: "0.5"`,
  `indexSchemaVersion: 2`) carries identity, publisher, license (with the
  notice path), the full embedding and chunking profiles, the shipped table of
  contents, shard statistics, every file's SHA-256, and an optional Ed25519
  signature over its RFC 8785 canonical form. The archive's own SHA-256 lives
  wherever the archive is named (the gilde entry, a registry row).
- Vectors use the two-stage `bit+int8` encoding: 384 sign bits for a hamming
  pre-filter, int8 for the cosine rerank, with the rounding rule pinned by the
  conformance kit. The reader keeps a shard's sign-bit rows in memory (9.6 MB
  per 200,000 chunks) and scans them; no index structure is part of the format.
- Embedding profiles are self-describing (Hugging Face repo + revision, the
  exact ONNX graph and tokenizer file with their sha256 digests, pooling,
  normalization, instructions, encoding). Published profiles:
  `multilingual-e5-small@1` (public catalogs) and `bge-small-en-v1.5@1`
  (local builds), both pinned to the full-precision `onnx/model.onnx`. A
  reader never mixes vectors across profile ids; matching only a dimension
  is unsafe, and gezel's embedders refuse to serve a profile whose fetched
  files do not hash to its pins (see [gezk-format.md](gezk-format.md)).
- References are publisher-qualified: `knowledge://<publisherId>/<catalogId>/<documentId>[#chunk=…]`.
  Within one install a catalog id still maps to one publisher (the user
  registry refuses a second), so product routes keep addressing catalogs by id.

Readers open every database read-only and immutable, check the
`application_id`/`user_version` stamps and the manifest's format version,
and never migrate: an incompatible catalog stays installed but disabled with
an actionable reason.

## Installation and storage lifecycle

Knowledge has two storage tiers. The first is an installer-owned machine asset
root for public, signed, redownloadable catalogs:

```text
Windows: %ProgramData%\Gezel\assets\knowledge\
macOS:   /Library/Application Support/Gezel/assets/knowledge/
Linux:   /var/lib/gezel/assets/knowledge/

assets/knowledge/
├── inventory.json                   published versions/digests, written atomically
├── downloads/
│   └── <publisher>-<id>-<version>.gezk.partial
└── catalogs/
    └── <publisher>/
        └── <id>/
            └── versions/
                └── <version>/
                    └── <sha256>/
                        ├── manifest.json
                        ├── index/
                        ├── LICENSES/
                        └── origin.json
```

The second is the user's private knowledge root. It owns all activation and
project policy and also stores local/private catalogs:

```text
~/.gezel/knowledge/
├── registry.json                    exact catalog refs, enablement, updates, policy
├── router.db                        effective per-user catalog router, rebuildable
├── downloads/
│   └── <publisher>-<id>-<version>.gezk.partial
└── catalogs/
    └── <publisher>/
        └── <id>/
            └── versions/
                └── <version>/
                    └── <sha256>/
                        ├── manifest.json
                        ├── index/
                        ├── LICENSES/
                        └── origin.json
```

Each user registry entry names the full immutable identity
`(publisherId, catalogId, version, contentDigest)` plus `storageScope:

"machine-shared" | "user"`, matching Gezel's existing storage-scope vocabulary.
The registry is authoritative; the manager does not scan both trees and apply an
implicit path precedence rule. Two users can point at the same machine bytes while
enabling different versions and project scopes. One user's update can publish a
new shared version, but it never changes another user's active reference.

No SQLite database is queried from inside the ZIP. Installation extracts to a
staging directory in the destination tier, validates there, closes all handles,
and atomically renames the version into place. Registries and inventories are the
pointers; filesystem symlinks are not required on Windows.

### Placement policy

- A catalog installed from the gilde catalog (a Bendyline release on Hugging
  Face) installs machine-wide by default when a machine engine is adopted. It is
  public, immutable, content-addressed, and recoverable from the Hub, so storing
  a second copy for every account has no privacy benefit.
- A locally built/imported catalog, unsigned catalog, arbitrary-URL download,
  private publisher catalog, or catalog with a user credential installs only in
  `~/.gezel/knowledge/`. Untrusted or private bytes are never made readable to
  every local account merely to save disk space.
- The CLI and advanced UI let a user force a catalog install into the private
  tier (`placement: user`; `gezel knowledge install <id> --private`). They must not offer a generic "make shared" switch for local or
  third-party archives. A future trusted-publisher program can widen the shared
  allowlist deliberately.
- In development, portable installs, or a degraded packaged install where no
  writable machine asset service is available, a catalog install falls back to
  the user tier and records that actual scope. Search remains functional. A later
  explicit `Move to shared location` flow may verify and promote it.
- In remote product mode, "machine" means the shared asset root on the daemon
  host, not the computer displaying the Electron UI.

Installation sequence:

1. Resolve a gilde catalog entry, explicit URL, or local file and apply the
   placement policy before any download.
2. For a shared install, the user daemon sends only the trusted coordinate
   (publisher, id, version, expected digest) to the loopback machine asset
   surface and follows its progress stream. The broker independently resolves
   the bytes through its own gilde pin (or a drop directory / optional signed
   registry). Arbitrary URLs and local paths are rejected by that surface.
3. Preflight free space for both the archive and expanded size in the selected
   tier.
4. Stream to a `.partial` file with cancellation, ETag, HTTP Range resume, and a
   byte ceiling.
5. Verify the archive SHA-256 before inflation.
6. Inspect the ZIP64 central directory without loading the archive into memory;
   reject traversal, absolute paths, symlinks, duplicate names, undeclared
   entries, excessive entry counts, size expansion, or compression bombs.
7. Extract only manifest-declared files into staging.
8. Verify every file hash, publisher signature, schema/profile compatibility,
   `PRAGMA quick_check`, counts, and bounded smoke queries.
9. Atomically publish the version. For a machine install, update the machine
   inventory and return an immutable descriptor; then the user daemon re-verifies
   the manifest, hashes, schema/profile, and smoke queries before writing its
   private registry reference and rebuilding its router.
10. Keep the previous active version until the new version passes; prune it only
    after publication succeeds.

The existing ZIP guard, `.gezapp` manifest/hash pattern, model install registry,
Gilde staging flow, disk-space preflight, and incomplete-download UI are the
patterns to reuse. The current in-memory `AdmZip` and 500 MB document limits are
not appropriate for multi-gigabyte catalogs; knowledge installation needs a
streaming ZIP reader and catalog-specific limits.

### Machine boundary and privacy

The machine asset surface is loopback-only and gets a dedicated, narrowly scoped
authorization capability such as `machine-knowledge-assets`; paired LAN inference
grants cannot call it. Its operations are content-addressed `ensure`, `status`,
`list public inventory`, and deliberately machine-wide reclamation. It does not
accept queries or return chunks. The per-user daemon mounts the published
directory read-only and owns every SQLite connection. Concurrent `ensure` requests
for the same digest coalesce into one staged download; the digest directory and
inventory record publish only after verification succeeds.

Shared storage does not mean shared usage. The shared inventory says only which
public immutable bytes exist on the device. The private registry says what this
user installed, enabled, pinned, or exposed to a project. Therefore a catalog
downloaded by Alice can be shown to Bob as `Already on this device`, but it does
not enter Bob's search or Knowledge browser until Bob explicitly adds it to his
own registry. Queries, retrieval telemetry, browser state, project choices, and
RAG results never go to the broker or another account.

The user daemon re-verifies a shared catalog before first mount and whenever its
trusted file identity changes. Databases open immutable/read-only, all result text
remains untrusted evidence, and an invalid shared asset is quarantined from that
user's router without reducing ordinary project search. Packaged installs must
give admitted local accounts read-only access to this exact public asset subtree,
not to the broker's runtime credentials or private service state.

### Ownership, cleanup, and backups

- Catalog (Hugging Face) installs are redownloadable machine assets. Each user's backup
  records the exact id/version/digest reference, enabled state, and project
  selections, not the shared bytes.
- A locally built or imported catalog may be the user's only copy. It is user
  content, is included in backups, and is never removed by
  `cleanup --redownloadable`.
- `Remove from my Gezel` closes that user's handles and removes their private
  reference. It deletes private bytes only when no private reference needs them;
  it never deletes shared bytes or affects another account.
- Shared physical reclamation is a separate, explicitly machine-wide storage
  action with a warning that other accounts may need to redownload the catalog. V1
  performs no automatic shared eviction and does not infer safe deletion from
  private per-user registries the broker cannot see. Lease-aware cleanup can be
  designed later if automatic pressure management becomes necessary.
- Storage reporting separates shared/redownloadable knowledge from private
  knowledge and makes `used by me` distinct from `present on this device`.
  Deletion always names the catalogs, scope, and reclaimed size.
- Installed versions are immutable. Update means install a new version and flip
  one user's registry pointer, never patch a live database or silently change
  another user's active version.

## Selection and project scope

Installation and use are separate concepts.

- `GezelConfig.knowledge` holds user-global defaults such as the auto-update
  preference; `registryUrl` is the machine broker's optional signed-registry
  seam and is ignored by the user daemon.
- A project inherits the global enabled set by default.
- `project.json` may override with `knowledgeCatalogs: { mode: "inherit" |
  "selected" | "off", refs?:

  [{ publisherId, catalogId }] }`. The user's registry resolves each reference to
  that user's active immutable version.

- Downloading or adding a catalog enables it for that user because that is their
  explicit act; any project can narrow or disable that inherited set.
- Project links do not change catalog scope. Catalog activation is user-level
  reference data, so A linking B neither duplicates nor grants a catalog.
- A craftbook step may include `knowledge` in its retrieval sources and may
  optionally narrow to publisher/catalog references. It never auto-downloads
  missing content.

Settings owns the current user's catalog references. Project Settings owns which
of those catalogs are in scope for that project. The machine inventory is storage
availability, not an activation or authorization list.

## Retrieval integration

Add `knowledge` to `RetrievalSourceSchema` and a new knowledge provenance shape to
`UnifiedSearchResult`:

```ts
{
  kind: 'knowledge',
  retrievalSource: 'knowledge',
  catalogId: 'physics-en',
  catalogVersion: '2026.08.0',
  documentId: '...',
  title: 'Classical mechanics',
  topicPath: ['Physics', 'Mechanics'],
  uri: 'knowledge://physics-en/...',
  sourceUrl: '...',
  attribution: '...',
  snippet: '...',
  score: 0.78
}
```

### Query flow

```text
query
  |
  +-- resolve active catalogs from global + project policy
  +-- group catalogs by exact embedding profile
  +-- embed once per profile
  +-- catalog/topic router selects likely internal shards
  +-- each selected shard: FTS5 + vector KNN -> reciprocal-rank fusion
  +-- cross-catalog merge: score calibration + dedupe + diversity caps
  `-- merge as one lower-priority arm beside project/shared/memory results
```

Small installations (up to roughly eight active catalogs) may query every catalog.
Larger installations use `~/.gezel/knowledge/router.db`, built from manifest
keywords and compiler-emitted topic centroids, to select a bounded set. Explicit
catalog filters bypass routing. The router is a performance hint, not an authority
boundary.

Project and shared material should normally outrank generic reference content.
Introduce a `knowledge` merge weight below project content, then use score floors
and diversity caps so one encyclopedic catalog cannot occupy the whole answer.
Initial defaults to validate in evals:

- explicit omni-search: at most 10 knowledge results and 3 per catalog;
- Lean proactive context: citations/paths only, at most 1 knowledge hit;
- Balanced: at most 2 knowledge chunks and 25% of the turn's retrieval budget;
- Deep: at most 4 knowledge chunks and 35% of the retrieval budget.

These are ceilings, not quotas. No qualifying hit means no knowledge content is
injected.

### Model tools

Keep one discovery surface. The existing `search` tool gains `knowledge` as a
source and an optional advanced `catalogs` filter; do not add separate
`search_knowledge`, `search_wikipedia`, or per-domain tools.

For deeper reads, extend `read_document` to accept a strict
`knowledge://<catalog-id>/<document-id>` URI returned by search. It reads a
bounded range from the installed catalog and remains read-only. This avoids a new
family of catalog file tools while keeping ordinary shared-library paths backward
compatible.

Models cannot CRUD catalog content. An author edits the source Markdown and builds
a new catalog version.

### Prompt safety and citations

Knowledge excerpts use the same untrusted-evidence boundary as current indexed
context. The prompt must say that catalog text can inform an answer but cannot
grant authority, change instructions, request tool calls, or override the
user/security policy. Browser rendering sanitizes Markdown and does not execute
HTML or scripts.

Every injected chunk carries catalog, document, source snapshot, and a stable
citation URI. Health, legal, financial, or other high-stakes answers should
surface source age and provenance rather than treating an offline encyclopedia as
current professional guidance.

## Service and client surface

Suggested first-party routes:

| Route | Purpose |
| --- | --- |
| `GET /api/knowledge/catalogs` | This user's catalog refs, storage scope, versions, health, size, enabled state |
| `GET /api/knowledge/available` | Every gilde `knowledge-catalog` entry joined with this user's registry, the machine-shared inventory, live installs and partial downloads; offline-safe (gilde is local) |
| `GET /api/knowledge/updates` | Installed catalogs with a strictly newer version in the shipped gilde content (`source: 'gilde'`; no network) |
| `POST /api/knowledge/install` | `{ source }` (file, URL, or a gilde `catalog` id) → `{ jobId, alreadyRunning }`; URL and catalog sources 403 `network-blocked` when the security policy turns off app network |
| `POST /api/knowledge/catalogs/:id/install?version=&placement=` | Install a gilde entry and stream its events as SSE; the job id is the catalog id, so a second request attaches to the running install |
| `DELETE /api/knowledge/catalogs/:id/install` | Cancel a running catalog install (disconnecting never cancels) |
| `GET /api/knowledge/active-installs` | Every running install with its latest progress (the polled twin of the SSE) |
| `GET /api/knowledge/incomplete` / `DELETE /api/knowledge/incomplete/:key` | Partial downloads no job is writing, resumable when the key still matches a gilde pin |
| `GET /api/knowledge/jobs/:id` | Job snapshot: started, finished, error, latest + terminal events |
| `GET /api/knowledge/jobs/:id/events` | SSE event stream for any job |
| `DELETE /api/knowledge/jobs/:id` | Cancel download/install |
| `PATCH /api/knowledge/catalogs/:id` | Enable, disable, or change auto-update |
| `DELETE /api/knowledge/catalogs/:id` | Remove this user's ref; reclaim only unreferenced private bytes |
| `POST /api/knowledge/search` | Browser/global search with catalog/topic filters |
| `GET /api/knowledge/catalogs/:id/topics` | Topic tree and counts |
| `GET /api/knowledge/catalogs/:id/documents` | Paged document directory |
| `GET /api/knowledge/catalogs/:id/documents/:docId` | Metadata + normalized Markdown body |

The model-facing project search route does not accept arbitrary project ids;
likewise it must resolve catalog ids against the session project's effective
policy rather than trusting request input.

Manual network downloads and automatic update checks both honor the app-network
security policy. Local `.gezk` import remains available offline. Search and
browsing of installed data never use the network. The shared install path uses a
separate user-daemon-to-broker client and allowlisted machine route, not these
renderer-facing product routes. A future machine-wide reclaim endpoint should live
with the other `/api/machine-*` management proxies and must not be confused with
removing a catalog from the current user.

## CLI authoring and management

The compiler is a Node-only package, tentatively `@bendyline/gezel-knowledge`,
with a streaming API:

```ts
compileKnowledgeCatalog({
  manifest,
  documents: AsyncIterable<CatalogDocument>,
  outputPath,
  embeddingProfile,
  onProgress,
})
```

The CLI's Markdown adapter and Qualla's Wikipedia adapter both feed that API. This
is the single owner of normalization, chunk ids, embedding profile, SQLite schema,
reproducibility, and validation.

Proposed commands:

```text
gezel knowledge init <folder>
gezel knowledge build <folder> --out <catalog.gezk> [--install]
gezel knowledge validate <catalog.gezk> [--deep]
gezel knowledge inspect <catalog.gezk>
gezel knowledge available
gezel knowledge install <catalog.gezk|url|catalog-id> [--sha256 <digest>] [--version <v>] [--private]
gezel knowledge export-parquet <catalog.gezk> [--out <dir>]
gezel knowledge list [--scope user|machine|all]
gezel knowledge search <query> [--catalog <id>]
gezel knowledge remove <id>
```

A gilde `catalog-id` prefers shared machine storage; `--private` forces a
private copy. Local files and arbitrary URLs are always private even if the caller
requests otherwise. `build --install` also installs privately because a newly
authored catalog is not yet a trusted public release. `remove` unregisters the
catalog for the current user and never purges shared bytes. The command output
always reports `Shared on this device`, `Only for you`, or `Shared store

unavailable; installed only for you` rather than requiring users to infer scope
from a path.

Arbitrary URL installs may include `--sha256` with an expected 64-character
digest obtained separately from the download URL. When supplied, the daemon
rejects altered downloads before extraction. Without a pin, it still hashes the
archive for immutable local identity, validates the archive and extracted files,
and keeps the catalog in the private, untrusted tier.

`knowledge init` writes a `knowledge.json` descriptor. For Markdown input:

- document id comes from frontmatter `id` or the normalized relative path;
- title comes from frontmatter, the first H1, or filename;
- folders become default topic paths;
- source URL, revision, authorship, language, and license can come from
  frontmatter or catalog defaults; and
- hidden files, generated output, symlinks, and the destination archive are
  excluded by default.

Builds are deterministic: sorted inputs, normalized paths/newlines, stable chunk
ids, pinned compiler/profile versions, normalized ZIP timestamps, and no
wall-clock values unless explicitly supplied. Identical inputs and toolchain
produce identical file hashes. The build report records document/chunk counts,
duplicate ids, skipped files, archive/expanded sizes, embedding time, and smoke
query results.

## Gezel desktop UX

### Settings -> Knowledge

Knowledge is a first-level Settings section rather than an AI engine. It shows:

- **Installed for you**: enabled state, version, source snapshot, size, document
  count, language, license, health, update, Remove, and a `Shared on this device`
  or `Only for you` badge;
- **Download a catalog**: the gilde entries as cards with description, topics,
  download and expanded sizes, publisher, release date, license, the Hugging
  Face dataset link, and Download. A catalog already in the
  shared store says `On this device` and can be added without downloading;
- **Import catalog**: choose a local `.gezk`, review identity/provenance/signature,
  and confirm; and
- live resumable download/install progress using the same visual language as model
  downloads.

The page works offline: installed catalogs always render, while the available
section shows the last verified registry snapshot or a quiet offline state.
Removing a shared catalog is labeled `Remove from my Gezel` and explains that it
does not reclaim machine storage. A separate advanced storage-management action
may reclaim public bytes from the whole device with a machine-wide warning; it is
not the ordinary Remove action.

### Project Settings

Add a Knowledge row with `Use global selection`, `Choose catalogs`, and `Off`. The
chosen list displays only installed compatible catalogs. Missing catalog ids from
a restored project are retained as unavailable references so reinstalling the
catalog restores the selection.

### Top-level Knowledge browser

Add `knowledge` to `RecentTabAreaSchema`, `AreaIcon`, `Sidebar`, and `TabContent`.
The sidebar link appears when this user's registered catalog count is at least
one, even if every catalog is temporarily disabled; machine bytes downloaded only
by another account do not make the area appear. The user still needs a way to
browse and re-enable registered content. A restored Knowledge selection with zero
catalogs redirects to Settings -> Knowledge.

The browser has:

- catalog and topic filters;
- full-text/semantic search across installed catalogs;
- a paged document list;
- a sanitized Markdown reader with source, revision/snapshot, license, and
  attribution always visible;
- `Copy citation` and `Open source` actions; and
- `Ask a gezel about this`, which starts or focuses a project chat with the
  `knowledge://` URI as an explicit reference.

Individual encyclopedia articles should not flood the global recent-selection
model. `KnowledgeView` keeps its document selection internally and accepts a
navigation intent when titlebar search opens a knowledge result.

## Qualla Wikipedia production

Qualla already has the right ingestion primitives:

- `DumpParser` streams compressed Wikipedia XML with bounded memory;
- `WikipediaAdapter` accepts `requireCoordinates: false`, emits namespace-0 topic
  articles, Markdown, categories, revision, timestamp, and stable curid source
  links; and
- Wikidata indices provide structured identity and classification features.

The knowledge path should reuse those parsers, but not the geohash-oriented
`RawArticleStore`, media, narration, or story pipeline. Add a dedicated
`build-knowledge-catalogs` command that adapts streamed articles directly into
`CatalogDocument` records for the shared compiler.

### Initial domain taxonomy

A candidate 26-catalog English taxonomy is:

1. Physics & Astronomy
2. Chemistry & Materials
3. Biology & Ecology
4. Medicine & Health
5. Earth Science & Climate
6. Geography & Places
7. World History & Archaeology
8. Government & Law
9. Economics & Business
10. Mathematics & Statistics
11. Computing
12. Engineering & Technology
13. Agriculture & Food
14. Transportation & Infrastructure
15. Languages & Linguistics
16. Literature
17. Visual Arts & Architecture
18. Music & Performing Arts
19. Philosophy & Religion
20. Psychology
21. Society & Culture
22. Education
23. Sports & Games
24. Military & Conflict
25. Biography
26. General Reference

This is a build hypothesis, not a permanent product taxonomy. Publish only after
measuring article counts, archive sizes, boundary quality, and common queries.
Very large domains should be split explicitly with stable new ids; very small
domains can merge before v1.

### Classification and duplication policy

Wikipedia's category strings are a graph, not a clean taxonomy. Classification
should combine:

- versioned seed Wikidata QIDs and instance/subclass ancestry;
- bounded Wikipedia category-graph expansion;
- infobox/type/category lexical rules; and
- deterministic fallbacks with a recorded confidence and rules hash.

Each article gets exactly one primary catalog to control download size, plus zero
or more secondary topic tags. A biography with a clear field belongs to that
field; Biography is the fallback for genuinely cross-domain lives. General
Reference catches unclassified material. Redirects become aliases rather than
duplicate documents.

The classifier emits an audit report: counts and bytes per catalog, low-
confidence/unclassified articles, cross-domain confusion samples, duplicates, and
changes from the previous taxonomy. Classification is deterministic; an LLM may
help review samples but must not be required to reproduce the corpus.

### Qualla build pipeline

```text
Wikipedia dump + Wikidata indices
  -> stream namespace-0 pages
  -> normalize Markdown + provenance
  -> classify primary catalog + topic path
  -> spool bounded NDJSON partitions (restartable)
  -> shared Gezel compiler: chunk + batch embed + write shards
  -> SQLite quick/integrity checks + smoke-query evals
  -> reproducible .gezk + manifest signatures + checksums
  -> publish immutable artifacts
  -> publish signed registry last
```

The build must be restartable at article, embedding-batch, and shard boundaries.
It records dump hashes, parser/compiler versions, taxonomy rules hash, embedding
profile, rejected articles, and timing. Embedding batches need bounded concurrency
and a persistent content-hash cache so an unchanged article is not re-embedded
every snapshot.

### Distribution contract (Hugging Face)

Catalogs are published as Hugging Face dataset repositories under the
`Bendyline` org, one per catalog, with commit-pinned download URLs:

```text
https://huggingface.co/datasets/Bendyline/<catalogId>/resolve/<commit-sha>/releases/<version>/<catalogId>-<version>.gezk
```

A commit sha never changes bytes, so "never reuse an archive URL for new
bytes" holds without any discipline on the branch. Each repo also carries a
Parquet companion of the same documents, chunks and embeddings for tools that
would rather scan tables than open SQLite. The product's trust root is the
gilde `knowledge-catalog` entry — `sha256`, `archiveBytes` and the pinned
`{ repo, revision, path }` shipped inside the exact-pinned `@bendyline/gilde`
package — exactly as chat models are trusted. The Ed25519-signed registry
(`gezk-registry`) remains supported as an optional artifact for third-party
publishers; `BUILTIN_KNOWLEDGE_TRUST_ANCHORS` stays empty until one ships.
The publisher id in manifests and citations is `bendyline`.

Source licensing, attribution, redistribution, and notice generation are a
release gate. Preserve each article's stable source URL and revision
metadata, ship required notices (`README.md` and `LICENSES/catalog.txt` are
required by the format), expose attribution in the browser and result
contract, and obtain legal review before the first public Wikipedia catalog.
Do not infer license obligations from this architecture document.

## Performance and quality gates

Do not begin with the full dump. Build a 100,000-article vertical slice that
contains all proposed domains and measure:

- archive and expanded bytes per document/chunk;
- vector bytes and embedding wall time;
- cold/warm p50 and p95 router + shard query latency;
- peak RAM and open file handles;
- install/extract/verify time and cancellation cleanup;
- retrieval recall@5, MRR, and cross-catalog routing misses;
- answer quality and citation accuracy with Knowledge off vs on; and
- prompt tokens added in Lean/Balanced/Deep.

Provisional gates to refine from the pilot:

- a shard is split before exact vector scans become visibly superlinear on the
  minimum supported CPU;
- proactive retrieval adds no more than roughly 250 ms p95 on a warm install;
- explicit knowledge search returns within roughly 750 ms p95 warm;
- routing recall@5 is within two percentage points of searching every shard;
- corrupt/incompatible catalogs never reduce ordinary project search; and
- activating more catalogs does not allow knowledge to crowd project evidence
  beyond the configured source budget.

Use `evals/src/index-bench/` as the starting harness and add catalog-routing,
Wikipedia-domain, citation, and prompt-injection scenarios. Qualla publishes a
small signed fixture catalog for Gezel integration tests; Gezel publishes the
reader/compiler compatibility matrix Qualla runs before CDN release.

## Observability and audit

History events should be low-volume:

- `knowledge.catalog.installed`
- `knowledge.catalog.updated`
- `knowledge.catalog.enabled`
- `knowledge.catalog.disabled`
- `knowledge.catalog.removed`
- `knowledge.catalog.install_failed`

Existing `retrieval.context-injected` telemetry grows catalog id/version, document
id, topic, score, and citation fields. It continues to omit raw query and excerpt
text. Search health reports incompatible profiles, corrupt/missing files, and
timed-out shards without failing unrelated search arms.

## Package and code ownership

Recommended boundaries:

- `packages/core`: manifest, user-registry, machine-inventory, storage-scope,
  trusted-coordinate, policy, path, API/result, and history schemas;
- new `packages/knowledge`: Node-only compiler, deterministic chunking adapter,
  read-only index reader, archive validation, signatures, and routing/ranking;
- `packages/service/src/knowledge/`: per-user manager, private install jobs,
  shared-asset client, read-only handle lifecycle, project policy resolution,
  SearchService arm, and product HTTP routes;
- the machine-role service route table: a separate allowlisted knowledge-asset
  manager for signed-coordinate ensure/status/inventory/reclaim only, with no
  reader, search, browser, project, or RAG surface;
- `packages/client`: typed management/search/browser wrappers;
- `packages/cli`: `gezel knowledge ...` commands and Markdown adapter;
- `packages/mcp`: extend `search` and `read_document` only;
- `packages/ui`: Settings page, Project Settings selector, conditional top-level
  area, and browser; and
- installers and supervisor discovery: exact shared knowledge path, public-read
  ACLs, private-write ACLs, machine credential scope, and degraded read-only
  mount/fallback behavior; and
- `qualla-internal/pipeline/knowledge/`: Wikipedia adapter, taxonomy, restartable
  build orchestration, signing, release reports, and CDN publish.

The compiler package is the key cross-repository seam. Qualla pins an exact
published version; it must not copy Gezel's SQLite DDL or chunker.

## Delivery phases

### Phase 0 - contracts and spike

- Freeze `.gezk` v1 schemas, embedding profile, stable document ids, and knowledge
  URI grammar.
- Record the narrow shared-asset boundary in `docs/service-boundaries.md` or an
  ADR: OS paths/ACLs, trust allowlist, broker credential scope, remote-host
  semantics, read-only mounts, fallback, and machine-wide cleanup rules.
- Build/read a 1,000-document Markdown fixture.
- Prove read-only sqlite-vec opening on Windows, macOS, and Linux.
- Benchmark one large shard before committing to shard sizes/vector encoding.

Exit: a deterministic archive passes cross-platform install and known-query tests
in two consecutive builds.

### Phase 1 - local compiler and CLI

- Add `packages/knowledge` and the Markdown document adapter.
- Ship `init`, `build`, `validate`, `inspect`, and local `search`.
- Add archive safety, reproducibility, manifests, and local signatures/hashes.

Exit: a user can compile Markdown into a finished `.gezk`, validate it, and search
it without a daemon.

### Phase 2 - private/shared install and service search

- Add per-user registry/router paths and machine inventory/catalog paths.
- Add private staged installation plus the broker's signed-coordinate shared
  ensure/status surface, immutable publication, public-read ACLs, degraded
  user-store fallback, backup/cleanup semantics, and health reporting.
- Prove that two user registries can mount one shared catalog while retaining
  independent enablement/version/project choices, and that neither user's search
  data reaches the broker.
- Add `knowledge` retrieval source and SearchService arm.
- Extend omni `search` and `read_document` with `knowledge://` citations.
- Keep proactive injection off for knowledge during this phase.

Exit: explicit search is ranked, cited, scoped, failure-isolated, and tested
against local and signed fixture catalogs.

### Phase 3 - Settings and browser

- Build Settings -> Knowledge, download/import/remove flows, and progress.
- Show `Shared on this device`, `Only for you`, `On this device`, and degraded
  fallback states; keep user removal distinct from machine storage reclamation.
- Add project-level catalog selection.
- Add the conditional Knowledge area, topic/document browser, and titlebar result
  navigation.
- Complete accessibility and screenshot-backed Electron UX coverage.

Exit: non-technical users can discover, install, understand, browse, disable, and
remove catalogs without using paths or ids.

### Phase 4 - proactive RAG

- Add policy/budget integration for Off/Lean/Balanced/Deep and craftbook-step
  overrides.
- Add source diversity, minimum scores, untrusted evidence markers, and
  catalog-aware retrieval telemetry.
- Run outcome evals with knowledge off/on before enabling it by default.

Exit: Balanced improves grounded outcomes without unacceptable latency or context
displacement.

### Phase 5 - Qualla pilot

- Implement deterministic classification and restartable catalog builds.
- Produce a 100,000-article, all-domain pilot.
- Decide final taxonomy, shard ceiling, vector encoding, and practical download
  tiers from measurements.
- Complete licensing/attribution review.

Exit: every proposed public catalog passes size, latency, routing, attribution,
and retrieval-quality gates.

### Phase 6 - signed CDN release

- Add Qualla signing, immutable artifact upload, signed registry publication, CDN
  cache policy, and release rollback.
- Ship several small domains first (rather than all Wikipedia at once).
- Add catalog update notifications; keep automatic large downloads off unless the
  user opts in.

Exit: a bad registry or catalog version can be withdrawn without breaking
installed catalogs or requiring a Gezel release.

### Phase 7 - scale and ecosystem

- Complete the 20-30 domain set.
- Add delta updates only if full-version downloads prove wasteful.
- Consider multilingual catalogs, community publisher trust, multiple embedding
  profiles, cross-catalog block deduplication, and lease-aware automatic shared
  eviction only after v1 is stable.

## Recommended v1 defaults

- Extension: `.gezk`, standard ZIP/ZIP64.
- Storage: signed public Qualla bytes shared once per device by default; local,
  private, arbitrary-URL, and unsigned bytes stored per user.
- Scope: exact catalog references and enablement remain per user, enabled on that
  user's explicit download/add, with a per-project override.
- Runtime: read-only extracted SQLite shards; never query inside ZIP.
- Content: compressed normalized Markdown in SQLite; no per-chunk files.
- Search: one omni `search`; deeper read through `read_document` and
  `knowledge://`.
- Embeddings: one exact pinned public profile; query once per profile.
- Updates: manual by default for large catalogs, immutable shared/private version
  installs, and no cross-user active-version flips.
- Trust: signed Qualla registry/catalogs, explicit review for unsigned local
  catalogs, no executable payloads, and no untrusted archive promotion into the
  shared machine store.
- Browser: top-level Knowledge area appears at one catalog registered for the
  current user; machine inventory alone does not reveal it. Settings always
  exists.
- Wikipedia: deterministic one-primary-domain partition with secondary topics;
  publish only after a measured 100,000-article pilot.

These defaults keep the first version understandable and local-first while leaving
clean seams for larger corpora, additional publishers, and alternate embedding
profiles.
