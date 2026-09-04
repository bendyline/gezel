# @bendyline/gezk

The `.gezk` knowledge-catalog **format**, as code: the manifest and registry
schemas (Zod), the id grammars, `knowledge://` references, the vector
quantization formulas, the SQLite DDL, RFC 8785 canonical JSON, and Ed25519
manifest signatures. It has no dependency on gezel — the product and the
`@bendyline/gezel-knowledge` toolchain (compiler, archive reader, retrieval)
both build on it.

- `@bendyline/gezk` — browser-safe: schemas, ids, URIs, quantization, DDL, JCS.
- `@bendyline/gezk/node` — everything above plus chunk ids, file digests and
  signing, which need `node:crypto` / `node:fs`.

The format specification, JSON Schemas, conformance fixtures and the Python
reference reader live in [bendyline/gezk](https://github.com/bendyline/gezk).
