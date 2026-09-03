# The `.gezk` format in gezel

The `.gezk` knowledge-catalog format is an **open format** specified outside
this repository: [bendyline/gezk](https://github.com/bendyline/gezk) holds
the specification (`spec/gezk-0.5.md`, CC BY 4.0), the JSON Schemas, the
conformance kit and a Python reference reader. Gezel is its reference
TypeScript implementation and the decision that opened it is
[ADR 0012](decisions/0012-gezk-open-format.md).

Current version: **0.5** (preliminary — a minor may break compatibility
until 1.0; readers support exactly the versions they name).

## Where things live here

| Concern | Package / file |
| --- | --- |
| Format definitions: manifest, registry, document and profile schemas, id grammars, `knowledge://` references, quantization, DDL, canonical JSON, signing | [`packages/gezk`](../packages/gezk) (`@bendyline/gezk`; `./node` adds the crypto/fs pieces). No gezel dependency. |
| Compiler, deterministic archive writer, verified archive reader, catalog handle (browse, FTS, two-stage semantic search), validator, profile registry, Markdown adapter | [`packages/knowledge`](../packages/knowledge) (`@bendyline/gezel-knowledge`) |
| Product plumbing: user registry, machine inventory, install/update requests, history kinds | [`packages/core/src/schemas/knowledge.ts`](../packages/core/src/schemas/knowledge.ts), which re-exports the format names **explicitly** — an `export *` from an external package is lowered by esbuild to a runtime namespace copy that never reaches the bundle's own exports (`knowledge-reexports.test.ts` guards the list) |
| The daemon's knowledge worker, install pipeline, broker, search arm | [`packages/service/src/knowledge/`](../packages/service/src/knowledge/), [`machine-engine/knowledge-assets.ts`](../packages/service/src/machine-engine/knowledge-assets.ts) |
| Product architecture (trust tiers, placement, UX, retrieval budgets) | [knowledge-catalogs.md](knowledge-catalogs.md) |

## Keeping the public artifacts in step

Both are generated, never hand-edited, and written into the sibling
`../gezk` checkout (`GEZK_DIR` overrides):

```bash
pnpm --filter @bendyline/gezk export-schemas              # schemas/*.schema.json from the Zod definitions
pnpm --filter @bendyline/gezel-knowledge build-conformance # conformance/ (fixture + vectors), also vendored into packages/knowledge/conformance/
```

`packages/knowledge/src/conformance.test.ts` holds this implementation to
the vendored kit; the gezk repository's CI holds the Python reader to the
same files. Regenerate both whenever the format changes, and bump the spec.

## Gezel-specific runtime notes (not part of the format)

- **One knowledge worker thread** owns every catalog SQLite connection
  (`node:sqlite` is synchronous); shard scans run sequentially inside it,
  32 open shard connections are kept in an LRU, and each mounted shard's
  sign-bit rows stay resident up to a 256 MB budget across catalogs.
- **Routing knobs**: `S = 3` shards for proactive retrieval, `S = 6` for
  explicit search, shared globally across active catalogs; stage-1 keeps
  `K = min(512, max(128, 8·finalK))` candidates with `finalK = 24`. These are
  runtime constants (`packages/knowledge/src/format/constants.ts`), not
  format constants.
- **Latency gates** (warm, from the knowledge-bench eval): ≤ 250 ms p95
  proactive retrieval, ≤ 750 ms p95 explicit search.
- **Query embedding is verified, not assumed.** A catalog's query vector
  comes from the daemon's own pipeline (`shared`) only when the daemon's
  model is a registered profile *and* its cached `onnx/model.onnx` and
  `tokenizer.json` hash to the digests that profile pins
  (`daemonEmbedderVerified` in `memory/embed-core.ts`, checked once per
  process). Otherwise a profile embedder loads exactly the pinned graph —
  precision read off `model.onnxFile`, never a transformers.js default —
  and refuses to serve if the fetched files differ from the pins
  (`artifact-verify.ts`); the catalog then searches by keyword only. The
  daemon's memory pipeline itself stays on the repo's `main` cache key so
  existing installs do not re-download; the digest check is what makes
  sharing it safe.
- **Merge weight** `MERGE_WEIGHTS.knowledge = 370`; relevance mapping
  `clamp01((cosine − 0.30) / 0.50)`.
- **Installed layout**: `~/.gezel/knowledge/catalogs/<publisher>/<catalog>/<version>/<digest16>/`
  (private tier) or the machine asset store (shared tier); the user registry
  keeps one catalog id per install, so product routes address catalogs by
  id while citations carry the publisher.
