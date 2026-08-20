# @bendyline/gezel-knowledge

The `.gezk` knowledge-catalog toolchain for
[gezel](https://github.com/bendyline/gezel): a deterministic compiler, a
verified archive reader, and a read-only catalog handle with two-stage
`bit384+int8` retrieval. One format and one runtime serve a 200-document
personal reference and a 2,000,000-document Wikipedia-class corpus.

```bash
npm install @bendyline/gezel-knowledge
```

## What a `.gezk` is

A standard ZIP holding `manifest.json`, a `router.db` (topics, document
directory, brotli bodies, routing centroids), and shard SQLite databases with
FTS and quantized vectors. Every catalog ships a browsable table of contents.
The format is frozen — see `docs/gezk-format-v1.md` in the gezel repo.

## Building a catalog

```ts
import {
  GEZEL_BGE_SMALL_EN_V15_1,
  GEZEL_MARKDOWN_CHUNKS_2,
  compileKnowledgeCatalog,
  createProfileEmbedder,
  loadMarkdownCatalog,
} from '@bendyline/gezel-knowledge';

const source = await loadMarkdownCatalog('./my-notes', { language: 'en' });
const embedder = await createProfileEmbedder(GEZEL_BGE_SMALL_EN_V15_1);
await compileKnowledgeCatalog({
  catalog: {
    id: 'my-notes',
    version: '1.0.0',
    name: 'My Notes',
    language: 'en',
    publisher: { id: 'me', name: 'Me' },
    createdAt: new Date().toISOString(),
    license: { name: 'MIT', attributionRequired: false },
  },
  topics: source.topics,
  documents: (async function* () {
    for (const doc of source.documents) yield doc;
  })(),
  outputPath: './my-notes-1.0.0.gezk',
  embeddingProfile: GEZEL_BGE_SMALL_EN_V15_1,
  chunkingProfile: GEZEL_MARKDOWN_CHUNKS_2,
  embed: (texts) => embedder.embed(texts),
  countTokens: (text) => embedder.countTokens(text),
  workDir: './.gezk-work',
});
```

Embedding requires `@huggingface/transformers` at runtime; the module is
imported dynamically so everything else works without it. The `gezel
knowledge` CLI wraps this same API (`init`, `build`, `validate`, `inspect`,
`search`), entirely offline — no daemon.

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

## Stability

Published for the gezel toolchain and the Qualla content pipeline. The
archive format is versioned (`formatVersion` / `indexSchemaVersion`) and
readers never migrate a catalog — incompatibility is a typed, reported
state.
