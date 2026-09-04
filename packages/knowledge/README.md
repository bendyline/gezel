# @bendyline/gezel-knowledge

The `.gezk` knowledge-catalog toolchain for
[gezel](https://github.com/bendyline/gezel): a deterministic compiler, a
verified archive reader, and a read-only catalog handle with two-stage
`bit+int8` retrieval. One format and one runtime serve a 200-document
personal reference and a 2,000,000-document Wikipedia-class corpus.

```bash
npm install @bendyline/gezel-knowledge
```

## What a `.gezk` is

An open format (gezk 0.5, preliminary until 1.0): a ZIP whose first entry is
the stored `mimetype` magic (`application/vnd.gezk+zip`), then
`manifest.json`, `README.md`, `LICENSES/`, a `router.db` (topics, document
directory, brotli bodies, routing centroids) and shard SQLite databases with
FTS5 and quantized vectors in plain BLOB tables. Nothing beyond stock SQLite
is needed to read one. The format definitions are the separate
[`@bendyline/gezk`](https://www.npmjs.com/package/@bendyline/gezk) package;
the specification, JSON Schemas, conformance fixtures and a Python reference
reader live in [bendyline/gezk](https://github.com/bendyline/gezk).

## Building a catalog

```ts
import {
  BGE_SMALL_EN_V15_1,
  MARKDOWN_CHUNKS_2,
  compileKnowledgeCatalog,
  createProfileEmbedder,
  loadMarkdownCatalog,
} from '@bendyline/gezel-knowledge';

const source = await loadMarkdownCatalog('./my-notes', { language: 'en' });
const embedder = await createProfileEmbedder(BGE_SMALL_EN_V15_1);
await compileKnowledgeCatalog({
  catalog: {
    id: 'my-notes',
    version: '1.0.0',
    name: 'My Notes',
    language: 'en',
    publisher: { id: 'me', name: 'Me' },
    createdAt: new Date().toISOString(),
    license: { name: 'MIT', spdx: 'MIT', attributionRequired: false },
  },
  topics: source.topics,
  documents: (async function* () {
    for (const doc of source.documents) yield doc;
  })(),
  outputPath: './my-notes-1.0.0.gezk',
  embeddingProfile: BGE_SMALL_EN_V15_1,
  chunkingProfile: MARKDOWN_CHUNKS_2,
  embed: (texts) => embedder.embed(texts),
  countTokens: (text) => embedder.countTokens(text),
  workDir: './.gezk-work',
});
```

Every archive ships a `README.md` and `LICENSES/catalog.txt`; the compiler
generates minimal ones from the catalog block unless you pass richer texts in
`extraFiles`. Embedding requires `@huggingface/transformers` at runtime; the
module is imported dynamically so everything else works without it. The
`gezel knowledge` CLI wraps this same API (`init`, `build`, `validate`,
`inspect`, `search`), entirely offline — no daemon.

## Reading a catalog

```ts
import { CatalogHandle, extractGezkVerified } from '@bendyline/gezel-knowledge';

await extractGezkVerified('./my-notes-1.0.0.gezk', './extracted');
const handle = CatalogHandle.open('./extracted');
const topics = handle.topics();
const hits = handle.searchDocumentsFts('woodworking');
handle.close();
```

Extraction verifies every file against the manifest (both directions —
undeclared and missing files are equally fatal) and rejects unsafe archive
entries. Catalog databases are opened strictly read-only and immutable.
Semantic search loads a shard's sign-bit rows into memory once (9.6 MB for a
full 200,000-chunk shard) and scans them with a popcount; the int8 rerank
reads the candidates by rowid.

## Stability

Published for the gezel toolchain and the Bendyline content pipeline. The
archive format is versioned (`formatVersion` / `indexSchemaVersion`) and
readers never migrate a catalog — incompatibility is a typed, reported
state. While the format is `0.x`, a minor release may break compatibility;
each reader names the exact versions it supports.
