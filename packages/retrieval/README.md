# @bendyline/gezel-retrieval

A mutable retrieval index for documents an app owns. Each document's Markdown is chunked by heading, indexed with SQLite FTS5, and searchable by BM25 with snippets and line spans. Documents are replaced or removed one at a time, so an app keeps the index current as its files change and reopens it across launches instead of rebuilding it.

It is the mutable counterpart to Gezel's `.gezk` knowledge catalogs and shares their semantics: the `markdown-chunks` profiles, the FTS tokenizer, and the query rule that drops words too common to rank by. It is browser-safe and runs in a Web Worker or a mobile WebView as well as in Node, over whatever synchronous SQLite handle the host supplies.

```ts
import { LiveIndex, markdownChunksByCharacters } from '@bendyline/gezel-retrieval';

const index = LiveIndex.open(db, {
  chunking: markdownChunksByCharacters(),
  appVersion: 'my-app-index@1',
});
if (index.reset) {
  // New, incompatible, or written by another app format: ingest everything.
}

index.upsert({ path: 'notes/garden.md', version: etag, title: 'Garden', body: markdown });
index.remove('notes/old.md');

// Diff against the app's own listing to find what changed while it was closed.
const known = new Map(index.manifest().map(({ path, version }) => [path, version]));

const hits = index.search('aphid spray', { limit: 20, perDocument: 3, prefix: true });
// → [{ path, title, headingPath, lineStart, lineEnd, snippet, ranges, score }]
```

## SQLite handles

- **Node**: `new DatabaseSync(path)` from `node:sqlite` satisfies `SqlDatabase` as is.
- **Browser worker / WebView**: `@bendyline/gezel-retrieval/sqlite-wasm` adapts the official sqlite-wasm build (`@sqlite.org/sqlite-wasm`, which the app bundles and serves `sqlite3.wasm` for). `openPoolDatabase` keeps the index in origin-private storage (the `opfs-sahpool` VFS, dedicated Worker only); `openMemoryDatabase` is for a context that cannot own the pool, such as a second window.

Only one context may hold a pool at a time; serialize owners with a Web Lock.

## What it stores

- **Documents**: the app's key (`path`), its change token (`version`), the title, the body that was chunked, and an opaque `payload` the app may use for anything.
- **Chunks**: heading path, line span and the chunk's location in the body. Chunk text is not copied; `fts_chunks` is an external-content FTS5 table reading through a view.
- **Meta**: the schema version, the app's format (`appVersion`) and the chunking id.

When the schema or `appVersion` changes, `open` empties the index and reports why in `reset`. When only the chunking changes, documents are re-chunked from their stored bodies with `rechunkStale()`, with no file reads; they stay searchable in the meantime.

## Not yet

Vectors (embedding profiles, quantized storage, hybrid fusion with Gezel's measured floors) arrive in a later release.
