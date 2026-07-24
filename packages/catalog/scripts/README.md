# Catalog scripts

Authoring- and import-time tools for the gilde catalog. None of this code
ships in the runtime catalog package.

**All content writes target the sibling
[bendyline/gilde](https://github.com/bendyline/gilde) checkout** (default
`../gilde`, overridable with `GILDE_DIR`) — catalog data no longer lives
in this repo. The scripts stay here because they import unpublished core
Zod schemas. The flow for any content change:

1. Edit or generate into `../gilde/data/...` (run `pnpm link:gilde` first
   so the daemon, tests, and evals resolve your checkout).
2. `pnpm --filter @bendyline/gezel-catalog build-index` (spawns gilde's
   canonical `tools/build-index.mjs`).
3. PR the gilde changes; its CI validates. After merge, the pipeline
   publishes `@bendyline/gilde`.
4. Bump the pin in `packages/catalog/package.json` and the
   `minimumReleaseAgeExclude` entry in `pnpm-workspace.yaml`, then
   `pnpm unlink:gilde`.

Durable importer state (`.import-state/import-watermark.json` and
`.import-state/import-slug-map.json`) stays in this repo; only content moves.
The slug map is content-coupled and moves only if the importer itself ever
relocates. Per-run diagnostics and the recomputable `.import-cache/` remain
local and untracked.

## `import-mcp-registry.ts`

Pulls permissively-licensed MCP server entries from
`registry.modelcontextprotocol.io` and writes them as gezel toolset
manifests under the gilde checkout's `data/community/toolsets/`. The
community catalog is a second tier loaded by `CommunitySource` (see
`../src/community-source.ts`); the bundled `data/toolsets/` tier stays
hand-curated. Batch the resulting gilde diff into a
`community-refresh/YYYY-MM-DD` PR.

### Run

```sh
# smoke test one well-known entry
pnpm --filter @bendyline/gezel-catalog import-mcp-registry \
  --package=io.github.modelcontextprotocol/server-filesystem \
  --dry-run --verbose

# bounded run for license / sha256 sanity (needs a token)
GITHUB_TOKEN=ghp_xxx pnpm --filter @bendyline/gezel-catalog import-mcp-registry \
  --limit=50 --verbose

# incremental sync (uses persisted watermark)
GITHUB_TOKEN=ghp_xxx pnpm --filter @bendyline/gezel-catalog import-mcp-registry

# full re-import
GITHUB_TOKEN=ghp_xxx pnpm --filter @bendyline/gezel-catalog import-mcp-registry --full
```

### Flags

| Flag | Effect |
|---|---|
| `--full` | Ignore the persisted watermark; sweep everything. Requires `GITHUB_TOKEN`. |
| `--since=<RFC3339>` | Override `updated_since` explicitly. |
| `--limit=<N>` | Process at most N entries (after pre-filtering). Capped runs do **not** advance the watermark. |
| `--package=<name>` | Single-entry mode (e.g. `--package=io.github.modelcontextprotocol/server-filesystem`). Skips watermark. |
| `--dry-run` | Compute outcomes without touching disk. |
| `--verbose` | Per-entry stdout. |
| `--help` | Show the help banner. |

### Environment

- `GITHUB_TOKEN` (or `GH_TOKEN`) — required for `--full`. The unauth
  GitHub API limit (60/hr) won't get through ~9k entries.

### What gets imported

- **Permissive licenses only**: `MIT`, `Apache-2.0`, `BSD-2-Clause`,
  `BSD-3-Clause`, `ISC`, `0BSD`, `MPL-2.0`, `CC0-1.0`, `Unlicense`.
  Anything else (GPL/AGPL/SSPL/BUSL/Commons Clause/`NOASSERTION`)
  goes in the per-run rejection log, not the catalog.
- **Status active or deprecated**. Deleted entries are dropped;
  deprecated entries are imported with their version listed in
  `yankedVersions[]`.
- **Runtime kinds**: `npm` + `stdio` packages → gezel `npm-package`
  runtime (re-hashed sha256 verified against the install pipeline).
  `remotes[]` entries → gezel `http-mcp` runtime (catalog-visible;
  ChatManager spawn for `http-mcp` is a separate follow-up). Other
  registry types (`pypi`, `oci`, `mcpb`) are deferred.
- **Tools list** is always empty; the live list is discovered by the
  MCP bridge at spawn time.

### State on disk

```
packages/catalog/scripts/
├── .import-state/
│   ├── import-watermark.json      latest publishedAt processed
│   ├── import-slug-map.json       upstream name → assigned gezel id
│   └── runs/{ISO}.json            local, gitignored summary + rejections
└── .import-cache/                 (gitignored — cheap to recompute)
    ├── npm/{pkg@ver}.json         tarball sha256 + entry path
    └── license/{owner__repo}.json GitHub license lookup, 30-day TTL
```

The slug map and watermark are committed so re-runs across machines stay
consistent and ids never reshuffle. Run summaries are local diagnostics and
must not be committed.

## `run-gilde-build-index.mjs`

Thin wrapper for the canonical index generator, which lives in the gilde
repo (`tools/build-index.mjs`) so gilde CI can verify index freshness
without any gezel dependency. Walks `data/` and `data/community/` in the
gilde checkout and emits a single `index.json` per kind directory
containing every resolved manifest. The runtime `BundledSource.list()`
reads this file directly and skips the per-item folder walk.

Toolset entries get an auto-derived `category` via the keyword heuristic
(vendored into gilde's `tools/lib/categorize.mjs`; the gezel copy is
[../src/categorize.ts](../src/categorize.ts)). A manual `category` value
on the identity manifest takes precedence.

### Run

```sh
# regenerate every kind under both data roots (the default)
pnpm --filter @bendyline/gezel-catalog build-index

# limit to one kind
pnpm --filter @bendyline/gezel-catalog build-index --kind=toolset
```

Re-run after any direct edit to `data/**/manifest.json` in the gilde
checkout or after an `import-mcp-registry` run. Gilde CI fails PRs whose
committed indexes are stale (`node tools/build-index.mjs --check`).

### Output

```
data/{kind-plural}/index.json
data/community/{kind-plural}/index.json
```

Each `index.json` is a JSON document:

```jsonc
{
  "schemaVersion": 1,
  "kind": "toolset",
  "count": 3799,
  "entries": [
    { "manifest": { /* full resolved CatalogItemManifest */ }, "iconSvg": "…" },
    …
  ]
}
```

The index is source-agnostic — `sourceId` and `logoUrl` are stamped
in by the runtime source on read, so multiple sources can share one
disk root without their entries colliding.

## `build-manifest.mjs`

Curates per-chat-model `manifest.json` entries from a small editorial
config. Pre-dates the importer; unaffected by it.

```sh
pnpm --filter @bendyline/gezel-catalog build-manifest \
  --config scripts/manifest-configs/<id>.json [--dry-run] [--reseed]
```

Runs via `tsx` (it imports the shared `src/manifest-assembly.ts`), so
invoke it through the package script or `tsx`, not bare `node`.

**Rebuilds are non-lossy.** A chat-model manifest has three classes of
field owned by three workflows:

| field class | examples | owner |
| --- | --- | --- |
| base metadata + source pointers | `name`, `tags`, `contextWindow`, `llamaCpp.huggingfaceRepo` | the editorial config |
| tuning / behaviour | `style`, `behaviors`, `tuning`, `evalHints` | **the manifest** — eval runs evolve these in place |
| `revision` pins | `llamaCpp.revision`, `mlx.revision` | `pin-revisions.ts` |

When a manifest already exists on disk, `build-manifest` keeps it
authoritative for the tuning/behaviour fields and carries over the
`revision` pins; it only refreshes the provider file data (sha256 / size /
file lists) from Hugging Face. This is why re-running it to refresh hashes
no longer wipes an eval-tuned `tuning` block (the regression that lost
mistral-medium's sampling defaults and the gemma4-26b QAT tuning).

Pass `--reseed` to deliberately let the config overwrite the base +
editorial fields (e.g. after you've intentionally updated the config).

The merge logic lives in `src/manifest-assembly.ts` and is guarded by
`src/manifest-assembly.test.ts`, whose `rebuild safety` suite re-runs the
assembly over every real manifest and fails if a rebuild would drop or
change any field — so a future lossy change is caught at commit time.
