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

# see what a reconcile would drop, without touching disk
pnpm --filter @bendyline/gezel-catalog import-mcp-registry --prune --dry-run --verbose

# routine refresh: pull what changed, drop what's gone
GITHUB_TOKEN=ghp_xxx pnpm --filter @bendyline/gezel-catalog import-mcp-registry --prune

# full re-import
GITHUB_TOKEN=ghp_xxx pnpm --filter @bendyline/gezel-catalog import-mcp-registry --full --prune
```

### Flags

| Flag | Effect |
|---|---|
| `--full` | Ignore the persisted watermark; sweep everything. Requires `GITHUB_TOKEN`. |
| `--since=<RFC3339>` | Override `updated_since` explicitly. |
| `--limit=<N>` | Process at most N entries (after pre-filtering). Capped runs do **not** advance the watermark. |
| `--package=<name>` | Single-entry mode (e.g. `--package=io.github.modelcontextprotocol/server-filesystem`). Skips watermark. |
| `--prune` | Reconcile on-disk entries against upstream and remove the ones it no longer vouches for. Rejected with `--package` / `--limit`. |
| `--prune-max-ratio=<F>` | Ratio ceiling for the prune guard (default `0.1`). |
| `--all-versions` | Import every published version, not just the newest. See [Version sprawl](#version-sprawl). |
| `--keep-versions=<N>` | Trim each imported toolset to its newest N eligible versions. Off by default. Rejected with `--package` / `--limit`. |
| `--retain-only` | Trim version history and nothing else — no import, no reconcile, no network. Requires `--keep-versions`. |
| `--dry-run` | Compute outcomes without touching disk. |
| `--verbose` | Per-entry stdout. |
| `--help` | Show the help banner. |

### Pruning

The import half only ever creates and updates. An entry that upstream
deletes is filtered out before the writer sees it, and one that
disappears from the registry entirely is never yielded at all — so
without `--prune` a discontinued server stays in the catalog forever
(bendyline/gilde#2).

`--prune` runs its own **complete** listing sweep (no `updated_since`,
~250 requests, no npm or GitHub calls) and removes any
`data/community/toolsets/{shard}/{slug}/` whose upstream name is either
flagged `status: deleted` or absent from that sweep. Because the sweep is
independent, `--prune` is accurate next to an incremental import — the
normal refresh is `import-mcp-registry --prune`.

Three guards bound the blast radius:

- Only slugs present in `import-slug-map.json` are removable. A
  hand-added directory is reported under `unmapped` and left alone.
- The slug map itself is **not** pruned. Allocation is
  first-come-first-served and persisted so ids never shift; dropping a
  mapping would let a later entry claim the freed base slug and bring a
  re-published server back under a different id.
- Removing more than `--prune-max-ratio` of imported entries (and more
  than 5 outright) aborts the pass with nothing deleted. A listing sweep
  truncated by a network flake is indistinguishable from mass deletion,
  and this is what keeps that from landing as a 3000-directory diff.

### Version sprawl

Each toolset directory holds one `versions/{semver}/manifest.json` per
release the importer has seen. Only the newest matters at read time:
both loaders (`pickVersion` in
[source.ts](../src/source.ts), and gilde's `manifest-merge.mjs`) resolve
an item to its **highest eligible** version, and the `availableVersions`
list they publish alongside it has no runtime consumer — installs go
through the resolved manifest's single `runtime` block.

So older folders buy exactly one thing: **yank fallback**. When the
newest version is later yanked, the loader falls through to the next
eligible folder. With a single folder on disk that fallback doesn't
exist and one yank drops the toolset out of the index entirely. That is
the argument for keeping a couple of versions, not for keeping all of
them.

Two independent controls:

**Ingest.** The import sweep lists upstream with `version=latest`, so a
run creates at most one new folder per server, and only when that server
actually published. An unfiltered listing instead returns one row per
*version* — and each row mints its own directory. That is not a
theoretical cost: the first unfiltered full sweep produced 22,850 version
folders across 6,338 toolsets (3.6× — one publisher alone accounted for
1,155) and an ~11,500-file pull request. `--all-versions` opts back into
the archive when you deliberately want it, e.g. reconstructing a yank
chain.

**Retention.** `--keep-versions=N` trims each imported toolset down to
its newest N eligible versions. It is **off by default and belongs in
its own PR**: compacting rewrites files already in gilde's git history,
and a routine refresh should not produce that churn. `3` is a reasonable
value — two fallbacks deep. Pair it with `--retain-only`: retention reads
only local disk, so that mode touches no network and finishes in seconds
instead of paying for a listing sweep it makes no use of.

```bash
# what would it drop?
pnpm --filter @bendyline/gezel-catalog import-mcp-registry \
  --retain-only --keep-versions=3 --dry-run

# do it
pnpm --filter @bendyline/gezel-catalog import-mcp-registry \
  --retain-only --keep-versions=3
```

Measured against the checkout as of 2026-08-09, `--keep-versions=3` drops
8,275 of 14,510 version folders across the 3,910 importer-owned toolsets.

**Retention's reach is capped by the slug map.** Only slugs recorded in
`.import-state/import-slug-map.json` are touched, and that file is
operator-local state — it is not committed alongside the content it
describes. On a checkout whose state directory has been reset or was
never populated, on-disk toolsets it doesn't know about are reported as
`unmapped` and skipped by *both* prune and retention. The same run above
left 2,428 of 6,338 on-disk toolsets untouched for exactly that reason.
If a sweep reports a large `unmapped` count, the state directory is stale
relative to the content — reconcile that first rather than raising any
ceiling.

Retention carries no removal-ratio ceiling, unlike `--prune`. That guard
exists because prune's input is a network sweep and a truncated one looks
exactly like mass deletion; retention reads only local disk, and its
expected first run removes ~70% of all version folders by design. Its
guards are structural instead:

- Only slugs in `import-slug-map.json` are touched; a hand-added
  directory is reported and left alone.
- A toolset whose identity manifest is missing or unparseable is
  skipped — without `yankedVersions` / `minSupportedVersion` there is no
  way to compute eligibility, and guessing deletes the wrong folders.
- A toolset with **zero** eligible versions is left completely alone.
  That state is a deliberate tombstone (every folder yanked), and the
  loaders distinguish `tombstoned` from `no-eligible-versions`; emptying
  `versions/` would silently convert one into the other.
- Folder names that aren't semver are never removed. The loaders already
  ignore them, and we don't reorder what we can't parse.

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
  `yankedVersions[]`. Dropping is not removal — an entry deleted after
  it was imported comes off disk via `--prune`, below.
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
