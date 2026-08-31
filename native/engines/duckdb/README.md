# duckdb

Upstream: https://github.com/duckdb/duckdb — MIT licensed.

DuckDB is an in-process analytical SQL engine. Gezel bundles its
**single-file CLI** as the query engine for *observation corpora* — the
tabular connector shape that mirrors high-volume sources (Azure Monitor
/ Log Analytics, CDN logs, billing exports) as partitioned Parquet
instead of one markdown file per record.

The CLI, rather than a native Node addon, is deliberate:

- It is one statically-linked file per platform, which is exactly the
  shape `native/` already ships and signs. A Node addon would add an
  ABI surface across the embedded / spawned / packaged supervisor
  matrix for no gain.
- A runaway query is a killable child process rather than a runaway
  allocation inside the daemon's heap.
- Compaction (`COPY … TO … (FORMAT parquet)`) means gezel needs **no
  Parquet encoder dependency in Node at all** — the engine we already
  ship for querying does the writing too.

Unlike llama-cpp and sd-cpp, this directory does not compile from
source. The build scripts **download** the appropriate precompiled
binary from duckdb/duckdb's GitHub Releases, verify it against a pinned
sha256, smoke-test it, and drop it in the canonical native-build tree.

## Produced binary

`duckdb` (or `duckdb.exe` on Windows). Gezel invokes it as a one-shot
child per query — SQL on **stdin**, never in `argv` — reading results
back as JSON:

```sh
echo "SELECT 1;" | duckdb -json :memory:
```

## Platform matrix

| Platform       | Release asset                     | Variant |
| -------------- | --------------------------------- | ------- |
| `darwin-arm64` | `duckdb_cli-osx-arm64.zip`        | — (single variant) |
| `linux-x64`    | `duckdb_cli-linux-amd64.zip`      | — |
| `linux-arm64`  | `duckdb_cli-linux-arm64.zip`      | — |
| `win32-x64`    | `duckdb_cli-windows-amd64.zip`    | — |

No GPU variants — DuckDB is pure CPU. One binary per platform. The
glibc archives are pinned over the `-musl` variants to match the rest
of the native tree.

## Build locally

```sh
# macOS / Linux
./build.sh

# Windows (PowerShell)
pwsh -File .\build.ps1

# Both honor DUCKDB_ARCHIVE_OVERRIDE=<abspath> to skip the download when
# testing against a pre-fetched zip (airgapped CI, etc.). The sha256
# check is skipped on overrides — trust the caller.
```

Output lands at `native/build/<platform>/duckdb[.exe]`.

Both scripts smoke-test before installing: `duckdb --version` must
mention the pinned commit (proving the extracted binary is the build
the VERSION file claims), and `SELECT 1` must return `1`.

## Signing

DuckDB is vendored **unmodified**, so — like `uv` — the binary keeps its
upstream name (no `gezel-` prefix) and is excluded from our Windows
Authenticode signing via `packages/app/scripts/third-party-binaries.cjs`.
It is classified `vendor-hash-only` in `NATIVE_FILE_MANIFESTS.json`.

## Query sandboxing (read this before changing the runner)

The service never hands user SQL to a bare CLI. `DuckQueryRunner`
applies a configuration prelude and then `SET lock_configuration=true`,
which is verified against this pin. Measured against v1.5.5:

| Attempt | Result under the prelude |
| --- | --- |
| `read_csv` inside the corpus dir | **allowed** (the point) |
| `read_csv('/etc/passwd')` | Permission Error |
| `read_parquet('https://…')` | Permission Error |
| `INSTALL httpfs` | Permission Error |
| `COPY … TO '/tmp/x.csv'` | Permission Error |
| `SET enable_external_access=true` | Invalid Input Error (locked) |
| `SET allowed_directories=['/']` | Invalid Input Error (locked) |
| **`ATTACH '<corpus>/w.db'` + `CREATE TABLE`** | **ALLOWED — writes a real file** |

That last row is why the runner's **statement guard is load-bearing,
not defence in depth**: `enable_external_access=false` and
`lock_configuration=true` do not stop `ATTACH` from creating a writable
database inside an allowed directory. Only the leading-keyword
allowlist (`SELECT` / `WITH` / `DESCRIBE` / `SUMMARIZE` / `EXPLAIN`)
blocks it. Never relax the guard on the theory that the config lockdown
already covers writes.

## VERSION format

Differs from the llama-cpp / sd-cpp format because we don't clone
upstream. See [VERSION](./VERSION) — a `tag=`, a `commit=` (satisfies
the shared CI preflight's "unpinned → skip" check *and* the build
scripts' version smoke test), and per-platform `sha256_*` digests.
DuckDB publishes no companion `.sha256` files, so those digests are
computed from the archives themselves.
