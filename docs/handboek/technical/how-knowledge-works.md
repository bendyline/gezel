---
id: how-knowledge-works
title: How knowledge works in Gezel
order: 7
summary: The storage, embeddings, hybrid search, and portable .gezk catalogs behind Gezel's knowledge.
subcategory:
  id: how-gezel-works
  title: How Gezel works
  order: 1
---

# How knowledge works in Gezel

Gezel brings relevant information into a conversation from your files, your crew's memories, and installed reference catalogs. It stores that information locally, builds indexes to find it, and gives the language model selected excerpts with references to their sources. This is retrieval-augmented generation, usually shortened to **RAG**: search supplies evidence that the model can use when answering.

An embedding is a numerical representation used to find related passages. It does not replace the original text, and installing a catalog does not train or change your chat model. You can inspect the source, search it with another model, or open a cited passage independently of the conversation.

This article explains the implementation. For a working build–validate–install example and the full command reference, see [Working with knowledge catalogs](knowledge-command-line.md). For the everyday concepts, see [Memory, documents, and the shared library](../conceptual/memory-and-documents.md).

## The kinds of knowledge

Several sources meet in search, but they have different owners and lifecycles:

| Source | Authoritative content | Search storage | Scope |
| --- | --- | --- | --- |
| Gezel memory | Daily Markdown notes and lessons | A rebuildable SQLite `mem.db` with text vectors | The named gezel |
| Project memory | Daily Markdown notes and lessons | A separate rebuildable `mem.db` | The project |
| Workspace and artifacts | Your original files and produced artifacts | Content indexes with structural data, full-text search, and, where supported, embeddings | The active project and explicitly admitted sources |
| Shared document library | Your library files | The shared library project's content index | Available across projects |
| Reference catalogs | Documents, metadata, and indexes shipped in a `.gezk` file | Immutable SQLite databases extracted from the catalog | Installed and enabled catalogs, intersected with project selection |
| Chat and history | Session JSON and the append-only history log | A rebuildable global full-text mirror | The permitted session/history search surface |

The shared library is a project internally, so it uses the same document conversion and indexing machinery as a workspace. Its live project id is recorded in configuration; code resolves it rather than assuming the id is always `shared`.

Project About and Mission Objectives are another path into the model's context: they are included directly in the standing instructions for a session. Searching a library or catalog is selective and happens separately.

## Local databases and ownership

Gezel's vector database implementation is embedded in the service. Mutable memory and content indexes use Node's built-in `node:sqlite`, SQLite FTS5 for keyword search, and the **sqlite-vec** extension for text vector search. They do not require a separate database server.

The main storage locations are:

| Location | Contents |
| --- | --- |
| `~/.gezel/gezels/<id>/memories/index/mem.db` | Derived vector index for a gezel's memory |
| `~/.gezel/projects/<id>/memories/index/mem.db` | Account-local derived vector index for project memory |
| `<workspace>/.gezel/index/index.db` | Content index for an ordinary writable workspace |
| `~/.gezel/projects/<id>/index/index.db` | Content index when the workspace cannot host it, and for the shared library or machine-shared projects |
| `~/.gezel/index/global.db` | Full-text mirror of sessions and history; this database does not store embeddings |
| `~/.gezel/knowledge/registry.json` | Your installed catalog references and enabled state |
| `~/.gezel/knowledge/catalogs/<publisher>/<catalog>/<version>/<digest16>/` | A private, immutable extracted catalog version |

Here `~/.gezel` means the active Gezel home; `GEZEL_HOME` can change it. External folder settings can move canonical files, while account-local memory indexes remain in the private home. The digest segment in a catalog path is the first 16 hexadecimal characters of its archive SHA-256, so different bytes with the same version label occupy different directories.

The mutable databases are derived caches. Daily memory files, workspace documents, sessions, and history remain the sources from which their indexes can be rebuilt. Catalog databases have a different role: they are part of a publisher's versioned artifact and are verified and opened without modification. Reinstalling or rebuilding a catalog replaces its version; the reader does not migrate it in place.

The shared library's database stays outside your documents folder, even when that folder is writable. Derived document conversions live under the project's `artifacts/shadow/`. This keeps mutable SQLite and generated search machinery out of a library that may be synchronized by a cloud storage client. See [Where files live](where-files-live.md) for the wider layout.

## From a file to a searchable passage

The content index has a deterministic structural pass and a separate enrichment pass. The structural pass discovers files, classifies them, checks modification time and size, then uses content hashes to avoid repeating work on unchanged content. It extracts supported code symbols and dependencies, Markdown headings, document text, and other searchable metadata without needing a language model.

Office documents and other convertible formats get a Markdown representation for search while the original file remains the visible document. Image descriptions and audio transcripts can provide additional text when the corresponding enrichment features are available. The Boekwachter, the crew member responsible for keeping material organized, uses this indexing and enrichment stack.

Enrichment can add summaries and text embeddings. Those operations have different costs: an embedding runs a local feature-extraction model, while an AI-written summary or description uses the configured inference path. A file can therefore be found by name or keyword before its semantic enrichment has completed. Disabling or losing the embedding runtime does not erase the original content.

Long documents are split into passages, or **chunks**, so that a search returns the relevant section instead of one vector for an entire book. Chunks retain source locations and heading context. The workspace Markdown chunker uses character bounds; portable catalogs use their declared chunking profile and tokenizer. These are separate contracts and should not be treated as interchangeable.

## Embeddings and vector spaces

An embedding model maps text to a vector. Related meanings should produce vectors with similar directions, allowing a question such as “how do I keep a catalog private?” to retrieve a passage about per-user installation even when it uses different words.

The default daemon text embedder is `Xenova/bge-small-en-v1.5`, producing **384-dimensional**, mean-pooled, L2-normalized vectors through Transformers.js and ONNX. The model is loaded lazily, and inference uses bounded sub-batches to limit temporary memory use. Once its model files are cached, text embedding runs locally without sending the text to an embedding service.

BGE has a query-side instruction: `Represent this sentence for searching relevant passages: `. Gezel prepends it to a search query, while indexed passages receive no prefix. The multilingual E5 family instead uses `query: ` and `passage: ` on the two sides. Pooling, normalization, tokenization, and these instructions all affect the vector space.

Two vectors having the same length does not make them comparable. If you change the daemon embedder, the mutable indexes detect a changed embedder stamp and regenerate their embeddings. A change in dimensions also requires the matching `GEZEL_EMBED_DIM` setting for content indexes. Existing summaries can be reused; the source documents do not need to be rewritten.

### Catalog embedding profiles

A `.gezk` embedding profile records enough information to reproduce its vectors: model repository and revision, ONNX graph path and digest, tokenizer identity and digest, query and passage instructions, pooling, normalization, dimensions, token limit, and quantization rules. The catalog echoes this profile in its manifest and database metadata.

The current registered profiles are:

| Profile | Language use | Query / passage instructions | Stage-one encoding |
| --- | --- | --- | --- |
| `bge-small-en-v1.5@1` | English; default for local catalog builds and the Handboek | BGE query instruction / no passage prefix | Raw sign bits |
| `multilingual-e5-small@2` | Multilingual reference catalogs | `query: ` / `passage: ` | Centered sign bits |
| `multilingual-e5-small@1` | Existing catalogs using the earlier E5 profile | `query: ` / `passage: ` | Raw sign bits |
| `embeddinggemma-2-512@1` | Catalogs with searchable photos, video and audio | `task: search result \| query: ` / `title: none \| text: ` | Centered sign bits |

The BGE and E5 profiles use 384 dimensions, a 512-token model window, and `bit+int8` storage. E5 revisions 1 and 2 share the underlying float vector space and int8 rerank representation; revision 2 changes the binary prefilter. The reader takes the centering vector from the catalog's own profile.

`embeddinggemma-2-512@1` is Google's EmbeddingGemma 2 at 8-bit precision. The model produces 768 values; the profile keeps the first 512 and re-normalizes them (Matryoshka truncation), which the profile records so every reader truncates the same way. Its vision and audio encoders put photos, video frames and sound into the same space as text, so a catalog built with it can carry **media rows**: one per photo and one per 30-second window of a clip or recording. A text question finds them directly. Media rows are searched in their own exact lane, because a photo sits further from its description than a passage does and would rarely survive the text shortlist, and at most four reach a search's results, one per document. A media kind with no measured cosine floor contributes no vector evidence. Catalogs using this profile need format 0.8.

Gezel reuses the daemon query embedder for a catalog only when the declared vector space matches and the cached model and tokenizer bytes pass the profile's pinned hash checks. A different supported profile gets its own pinned query embedder. An unknown or unavailable profile leaves browsing and keyword search usable; Gezel does not substitute a same-sized vector from another model.

## Mutable vector search

Memory vectors are stored in a sqlite-vec `vec_mem` virtual table, joined by row id to the `mem` table containing text, scope, date, and memory kind. Text vectors in a content index use `vec_text`, joined to chunks and their source files. The vectors are float arrays; a default 384-dimensional float32 vector occupies 1,536 bytes before database overhead.

New vector tables declare cosine distance. For those tables, similarity is `1 − distance`. The content reader also handles older tables that used sqlite-vec's default distance metric, so legacy distances are interpreted according to the table's actual declaration.

Content search combines the vector neighbors with FTS results over symbols, summaries, and document chunks. It uses rank fusion to combine independently ranked lists, deduplicates overlapping source locations, and limits how many results one path can contribute. This allows an exact symbol name and a semantically related explanation to support the same result without comparing a BM25 keyword score directly with a cosine score.

Media embeddings have their own storage path: content indexes keep them in a plain `media_vectors` BLOB table keyed by content hash and, for video and audio, the start of each 30-second window, and search them with exact cosine scoring. They come from the same EmbeddingGemma 2 model and 512-dimension space as `embeddinggemma-2-512@1` catalogs, so a workspace photo and a catalog photo answer the same text query. They are independent of the text `vec_text` table and its dimensions. Turning media search on downloads the model once (about 510 MB for photos; the audio encoder, about 340 MB more, arrives the first time a video or recording is indexed). Video and audio also need a system `ffmpeg` (`GEZEL_FFMPEG`, `SQUISQ_FFMPEG`, or on `PATH`); without one, those files are found by name only. The portable catalog vectors described next also use plain BLOBs, but follow the `.gezk` format's separate encoding rules.

## What a `.gezk` file contains

A `.gezk` is a portable reference catalog containing its source documents and prepared search indexes. The open format is specified in [bendyline/gezk](https://github.com/bendyline/gezk). The current source implementation writes the [0.7 draft specification](https://github.com/bendyline/gezk/blob/main/spec/gezk-0.7.md), paired with index schema 4, and retains reads of 0.5/schema 2 and 0.6/schema 3. Published reader packages may support earlier generations: check the supported format set of the reader you deploy.

The format version, index schema version, catalog's content version, and npm package version are separate identifiers. While the format remains `0.x`, a new minor format can be incompatible. Readers accept an explicit set of generations and refuse unsupported versions with a reported reason.

```text
my-reference.gezk
  mimetype                         application/vnd.gezk+zip
  manifest.json                    identity, profiles, counts, hashes, optional signature
  README.md                        provenance and description
  LICENSES/catalog.txt             content license
  LICENSES/source-notices.json      optional source attribution
  assets/...                       optional document images
  index/router.db                  topics, documents, bodies, locations, routing centroids
  index/shards/000.db               chunks, FTS5, binary and int8 vectors
  index/shards/001.db               additional shards when needed
```

The container is a ZIP with a stored `mimetype` entry first. Entries are stored without ZIP compression; document Markdown bodies use either plain bytes or Brotli inside SQLite. Retrieval runs against verified, extracted databases rather than searching within the ZIP.

The example shows the layout with external shards. A small catalog, with at most the 200,000-chunk target, embeds its single shard's tables in `router.db` and needs no separate shard file. The shard directory records that path, so readers follow the catalog's own shard map instead of assuming `index/shards/000.db` exists.

The router contains the topic hierarchy, document directory, complete document bodies, aliases, and shard routing centroids. It has a document-level FTS5 index over titles, summaries, and aliases. Each shard contains chunk text, heading paths, inclusive source line ranges, content hashes, a chunk FTS5 index, and two vector tables: `chunk_vectors_bit` and `chunk_vectors_int8`.

Catalog databases need **stock SQLite with FTS5**, without sqlite-vec. Vectors are ordinary BLOB columns and the reader performs their scoring. Chunk ids align with both vector tables and FTS row ids, making the rerank and source lookup direct.

### Topics, shared placements, and locations

In the 0.7 draft, `topic_documents` lets one document appear under several table-of-contents topics. Its body, chunks, vectors, and citation identity remain canonical. A subtree listing deduplicates documents before counting and pagination, so a shared placement does not create another search result or another copy of a passage.

The draft also carries typed geographic points in `document_locations`. A `subject` location describes what an article is about; an `associated` location records a related place. Radius discovery uses subject locations and the `sphere-6371000` distance contract, not a guess based on place names in prose. A spatial search first restricts eligible documents, then searches passages in that set. Catalogs without usable subject coordinates can still be searched normally. See the companion reference for [`nearby` and radius-filtered search](knowledge-command-line.md).

### Catalog compilation

The compiler normalizes the input documents, assigns stable document and chunk identities, embeds passages, writes the router and shards, and emits the manifest and archive. The CLI accepts a Markdown tree and recognizes existing outlines such as GitBook `SUMMARY.md`, MkDocs navigation, Jupyter Book `_toc.yml`, DocFX TOCs, and Hugo conventions. Relative document links and supported image assets are adapted into catalog references.

The default catalog chunking profile, `markdown-chunks@2`, targets 420 tokens with 64 tokens of overlap, counted by the embedding profile's tokenizer. It adds a bounded title and heading context header, recorded by the profile with a maximum of 64 tokens. Source line ranges refer to the normalized document body, allowing a retrieved passage to lead back to its surrounding text.

The compiler uses deterministic ordering and encodings. Reproducible archive bytes also require stable inputs, including the declared creation time and the same pinned model artifacts. The CLI otherwise supplies the current creation time when you omit it.

## Two-stage catalog vector search

Portable catalogs store a compact approximation of each normalized passage vector in two forms:

| Representation | Bytes for 384 dimensions | Use |
| --- | --- | --- |
| Sign bits | 48 | Scan cheaply to shortlist candidates |
| Signed int8 values | 384 | Rerank the shortlist against the float query |
| Combined | 432 | Stored vector payload, excluding rows and indexes |

This is about 3.6 times smaller than a 1,536-byte float32 vector. A 200,000-chunk shard's sign-bit payload is 9.6 MB, so the reader can keep that stage in memory without hydrating all full vectors or document bodies.

For each query, the catalog search path is:

```text
Question
  -> eligible catalogs grouped by compatible embedding profile
  -> float query embedding in each required vector space
  -> centroid routing selects shards
  -> sign-bit scan produces candidate chunk ids
  -> int8 rerank reads the shortlisted vectors
  -> keyword and vector rankings are fused per document
  -> selected passage + knowledge:// citation
```

**Routing.** A shard is scored by its best matching routing centroid. The compiler targets 200,000 chunks per shard, with a maximum of 250,000, and builds multiple centroids for routing. The explicit search manager spends a six-shard vector budget across catalogs within each query-profile group. The reader also exposes a three-shard proactive routing default. Keyword title search is performed across the active catalogs independently of vector routing.

**Stage one.** Gezel's optimized reader scores a float query against the stored sign bits with an asymmetric lookup-table scan. The specification also defines a binary-query Hamming baseline. With `centered-sign`, both the passage bits and the scan query use `vector − center`; the center removes a common direction that would otherwise dominate E5's binary representation. This centering applies only to the binary stage.

**Stage two.** For each selected shard, the current candidate count is `min(4096, max(1024, 32 × finalK), eligibleChunkCount)`. The ordinary `finalK` is 24, giving up to 1,024 candidates. The reader loads their int8 BLOBs by chunk id and scores the original, uncentered float query against the dequantized passage vectors.

The int8 rule is `clamp(round(127 × x), −127, 127)` for a normalized component `x`, with the specification's precise rounding semantics. Dequantization divides by 127; the dot product approximates the original cosine similarity. No SQLite extension controls these formulas.

Catalog SQLite work runs on a dedicated knowledge worker thread, keeping synchronous shard scans off the daemon's main event loop. Shards are scanned sequentially within a request. Each catalog handle caches sign-bit arrays with a 256 MiB eviction budget; this is a cache budget per handle, not a total process memory guarantee.

Routing and quantization trade exhaustive recall for bounded work. A relevant passage can be missed if its shard is not selected or its binary approximation falls outside the shortlist. Exact titles and keywords provide another retrieval path, and catalog producers can measure routed results against a scan of every shard. Large reference collections benefit from subject-focused catalogs rather than relying on a small shard budget to cover an arbitrarily broad corpus.

## Hybrid ranking and selecting evidence

An explicit catalog search combines three ranked lists: vector passages, document title/summary/alias matches, and chunk-body keyword matches. These are fused **per document** using reciprocal rank fusion with `k = 60` and weights `1 / 1 / 0.5`, respectively. The selected document retains a representative passage when one is available.

The fused ordering maps to relevance as `11 / (11 + rank)`, using a zero-based rank. This measures position in the result list, not the probability that a statement is true. Across the wider search surface, calibrated relevance is multiplied by a source-kind priority; generic reference knowledge has a lower priority than the user's project content.

Nearest-neighbor search always has a nearest result, even for an unrelated question. Gezel therefore applies measured cosine floors by embedding profile or catalog before treating a vector match as useful evidence. Cosine ranges differ substantially between models and corpora; a single universal threshold would be misleading. When an optional calibrated relevance model is available, it can further judge and rerank candidates, with stricter admission rules for unsolicited catalog excerpts.

Proactive retrieval is bounded separately from a full search. It diversifies sources so reference material does not consume the entire context window. Lean mode includes catalog citations without body text; Balanced admits at most two catalog chunks within 25% of the retrieval token budget; Deep admits at most four within 35%. These are ceilings: a turn with no qualifying catalog evidence includes none. Cold or unavailable embeddings can leave a turn with keyword results or no semantic recall while a model warms in the background.

Memory recall has an additional time dimension. Durable facts, decisions, and preferences remain searchable, while `status` notes decay for automatic recall so an old “the build is broken” observation does not keep appearing as current state. Dates and source scope remain attached to recalled notes.

## Scope, citations, and model context

Each session has a named gezel and a project. The model-facing `search` tool searches the admitted workspace, artifacts, project memory, that gezel's memory, shared library, and reference catalogs. It can restrict sources or catalog ids. Project catalog policy is `inherit`, `selected`, or `off`; a selected catalog must also be installed, enabled, and successfully mounted.

The Knowledge browser and `gezel knowledge find` use the user's installed catalog search surface. They do not implicitly adopt the project policy of whichever directory the CLI runs in. Project-scoped retrieval applies that policy through the session's project context.

Catalog citations use a parsed URI grammar:

```text
knowledge://publisher/catalog/document
knowledge://publisher/catalog/document#line=3-9
knowledge://publisher/catalog/document#chunk=0123456789abcdef0123456789abcdef
```

The first form identifies a document, the second a line range, and the third a content-derived passage id. Gezel's `read_document` tool opens these references. Retrieval records carry the catalog version as provenance, but the URI itself does not pin a version: it resolves through the user's currently mounted catalog. After an update, a changed chunk can cease to resolve; exact reproducibility requires retaining the corresponding catalog version and archive digest.

Retrieved text is presented as **untrusted evidence** with provenance. It can inform an answer, but instructions found inside a document do not gain authority to change the task or invoke tools. Installing a catalog changes the available reference material; it grants no workspace write permission.

## Installation, integrity, and updates

An installation resolves a catalog id, local archive, or URL; checks space and archive constraints; downloads or reads the bytes; verifies the archive and manifest; extracts into staging; validates the databases; then publishes an immutable version and updates the user registry. Downloads can retain partial data for a later resume. Install progress is streamed, and disconnecting a progress subscriber does not itself cancel the job.

Archive checks reject unsafe paths and entries, reconcile declared files with actual files, and check sizes and SHA-256 digests. Deep validation additionally checks SQLite integrity, chunk/vector alignment, self-neighbor behavior, and declared keyword smoke queries. A mount failure quarantines the catalog instead of rewriting its databases or breaking unrelated search sources.

The format supports Ed25519 manifest signatures over RFC 8785 canonical JSON. A signature is proof of origin only when verified against a trusted public key. File hashes establish consistency; they do not by themselves establish who published the content. The current Gilde install path trusts the archive identity and digest pinned by its catalog entry, and local file imports may be unsigned. Structural validation and a signature displayed by `inspect` should not be mistaken for an independent publisher-trust verdict.

Trusted public catalog downloads can use the machine engine broker's immutable asset store, sharing the bytes once per computer. Your installed references, enabled state, and project selections remain per-user. Local imports and arbitrary URLs use private storage; a catalog-id install can also explicitly request private placement. If shared placement is unavailable, the user daemon can install privately.

The broker receives a trusted catalog coordinate, not a user project path. It manages public immutable bytes; user documents, memories, query embedding work, and retrieval remain product-daemon concerns. Removing a catalog removes your reference and private files, while shared public bytes are reclaimed separately. Background update work respects the app-network policy; an explicitly requested install is the user's own download.

The built-in Handboek is itself a `.gezk` catalog. Gezel builds it from these documentation articles and generated catalog material, then installs the bundled archive through the normal knowledge machinery. Updates replace changed bundled bytes while preserving your enabled setting.

## Diagnosing missing results

| Symptom | What to check |
| --- | --- |
| A file appears by name but not by meaning | Embedding readiness and project indexing/enrichment status; the structural pass can finish first |
| A memory cannot be recalled | Correct gezel/project scope, saved Markdown, memory index health, and any status-note age |
| A catalog appears installed but supplies no results | Enabled/mounted state, quarantine reason, project selection, and the query profile's readiness |
| Offline keyword search works but semantic search fails | Embedding runtime installation, cached pinned model files, and supported profile |
| A title is found but a related passage is missed | Shard routing and candidate limits; compare keyword and semantic results |
| A citation stops opening after an update | Currently mounted version and whether the referenced document or chunk still exists |
| A new catalog is refused by an older installation | The reader's supported format/schema generations; readers do not migrate archives |

Start with [`knowledge inspect`, `validate`, `list`, and `search`](knowledge-command-line.md). Project `/index/status` and service `/api/health` also expose embedding readiness. A successful keyword query proves a lexical path works; it does not prove the embedding pipeline is ready.

## Specification and implementation references

The public [gezk specification repository](https://github.com/bendyline/gezk) contains the [0.7 draft](https://github.com/bendyline/gezk/blob/main/spec/gezk-0.7.md), [versioned JSON Schemas](https://github.com/bendyline/gezk/tree/main/schemas), [conformance fixtures](https://github.com/bendyline/gezk/tree/main/conformance), and [Python reference reader](https://github.com/bendyline/gezk/tree/main/reference/python). The earlier [0.6](https://github.com/bendyline/gezk/blob/main/spec/gezk-0.6.md) and [0.5](https://github.com/bendyline/gezk/blob/main/spec/gezk-0.5.md) specifications remain available.

The TypeScript implementation has three layers:

- [`@bendyline/gezk`](https://github.com/bendyline/gezel/tree/main/packages/gezk): format schemas, identifiers, citation grammar, quantization, SQLite DDL, canonical JSON, and signing. It has no product dependency.
- [`@bendyline/gezel-knowledge`](https://github.com/bendyline/gezel/tree/main/packages/knowledge): compiler, Markdown adapter, archive verification, profile embedders, catalog reader, and validator.
- [The service knowledge manager](https://github.com/bendyline/gezel/tree/main/packages/service/src/knowledge): install jobs, user selection, machine asset coordination, worker ownership, and search integration. [Mutable index storage](https://github.com/bendyline/gezel/tree/main/packages/service/src/index-store) and [memory](https://github.com/bendyline/gezel/tree/main/packages/service/src/memory) implement the local, changing knowledge sources.

For practical manipulation, continue with [Working with knowledge catalogs](knowledge-command-line.md), or use [Writing scripts with gezel-sdk](writing-scripts-with-gezel-sdk.md) when the work belongs inside a project.
