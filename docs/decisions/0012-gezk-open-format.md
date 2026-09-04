# 0012 — gezk becomes an open format (0.5), published on Hugging Face

Status: Accepted (2026-09)

## Context

The `.gezk` knowledge-catalog format froze in August 2026 (`docs/gezk-format-v1.md`) and soft-launched with no external users. Gezel now wants to publish a number of ~1 GB catalogs (Wikipedia domain corpora with chunk embeddings) as open source on Hugging Face, and to let anyone build, host and read catalogs without gezel. v1 stood in the way on several fronts:

- Vectors lived in sqlite-vec `vec0` virtual tables. sqlite-vec is pre-1.0 and documents that its storage format may still break, so the public format would have depended on an extension's private layout.
- The identity was product-branded: `kind: gezel-knowledge-catalog`, `gezel-` profile ids, `compatibility.minimumGezelVersion`, and the schemas lived in `@bendyline/gezel` core, so a standalone reader pulled the product package.
- The archive deflated its entries (byte identity depended on the zlib build, and content-addressed hosting could not deduplicate across releases), carried no container magic, and had no published spec, JSON Schemas, conformance fixture or second implementation.
- `knowledge://` references had no publisher, which forced "one catalog id per install" to stand in for global uniqueness.

Alternatives for the container were checked once more before reshaping: Lance (the only established open format bundling content, embeddings and indexes; rejected for gezel's on-device use because its Node binding is a 221 MB native module, it has a single Rust implementation, its writes are not reproducible, and it parses untrusted files in-process), Parquet (the right companion for the corpus, not a container with an index) and ZIM (content only). The assessment is recorded in the planning notes for this change.

## Decision

1. **A format package with no product dependency.** `packages/gezk` (`@bendyline/gezk`) owns the manifest, registry, document and profile schemas, id grammars, `knowledge://` helpers, quantization, DDL, canonical JSON and Ed25519 signing. `@bendyline/gezel-knowledge` (compiler, archive reader, retrieval) depends on it; core re-exports the product-facing names *by name* — esbuild lowers `export *` from an external package to a runtime namespace copy that never reaches the bundle's own exports, which `knowledge-reexports.test.ts` guards.
2. **gezk 0.5.** `kind: gezk-catalog`, `formatVersion: "0.5"` (a string; `0.x` is preliminary and a reader supports exactly the versions it names), `indexSchemaVersion: 2`. Vectors are plain BLOB tables (`chunk_vectors_bit`, `chunk_vectors_int8`) with the same encoding as before; stage 1 is an in-memory hamming scan. The archive starts with a stored `mimetype` entry (`application/vnd.gezk+zip`) and stores every entry uncompressed. `README.md` and `LICENSES/catalog.txt` are required (the compiler synthesizes minimal ones). `requires` replaces `compatibility`; `toolchain` is a generic `{ name, version }`. Profiles are self-describing and unbranded (`multilingual-e5-small@1`, `bge-small-en-v1.5@1`, `markdown-chunks@2` with `unit / target / overlap / contextHeader.max`). The registry kind is `gezk-registry`.
3. **Publisher-qualified references.** `knowledge://<publisherId>/<catalogId>/<documentId>`. Within one install a catalog id still resolves to one publisher (the user registry refuses a second publisher's catalog with the same id), so product routes keep addressing catalogs by id.
4. **The spec lives outside the app.** `bendyline/gezk` carries the specification, JSON Schemas generated from the format package, a conformance fixture with test vectors, and a Python reference reader. The TypeScript implementation stays in gezel.
5. **Distribution on Hugging Face only**, one dataset repo per catalog under the `Bendyline` org, commit-pinned `resolve` URLs, with the gilde entry's sha256 as the product's trust root; the Ed25519-signed registry remains an optional artifact for third-party publishers.
6. **No v1 compatibility.** A reader refuses an earlier generation with a typed `format-version` reason; the internal pilots are rebuilt.

## Consequences

- Any SQLite client reads a catalog; the Python reader needs the standard library plus `brotli`.
- Builds are byte-identical independent of the zlib build, and Hugging Face's content-addressed storage deduplicates unchanged pages across releases.
- A reader holds 48 bytes per chunk of sign bits per mounted shard (9.6 MB for a full shard), bounded by a 256 MB budget.
- Quantization rounding is ECMAScript `Math.round` (half toward positive infinity); an implementation in another language must match it (Python: `floor(x + 0.5)`), which the conformance vectors check.
- `shards.bytes` is real for external shards and 0 for the shard embedded in `router.db`, whose size only the manifest knows.
- sqlite-vec leaves the knowledge package; the daemon keeps it for memory and project indexes.
