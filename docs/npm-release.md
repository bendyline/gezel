# npm release

How gezel's JavaScript packages get to npm. For the desktop installers see
[RELEASE.md](../RELEASE.md); the two pipelines are independent and share no
version line.

## What ships

Sixteen packages under the `@bendyline` scope, all public API under semver,
plus three unscoped short names (below):

| Package | What it is |
|---|---|
| `@bendyline/gezk` | The `.gezk` knowledge-catalog format: schemas, ids, references, quantization, DDL, signing (no gezel dependency) |
| `@bendyline/gezel` | Core types, Zod schemas, path helpers, gezel-markdown parser |
| `@bendyline/gezel-client` | Typed HTTP client for the daemon |
| `@bendyline/gezel-sdk` | The preferred extension surface |
| `@bendyline/gezel-app-sdk` | Embedding helpers for host applications: discovery and consent from `.`, in-process daemon hosting from `./host` |
| `@bendyline/gezel-plugin-sdk` | Legacy extension surface, kept for compatibility |
| `@bendyline/gezel-catalog` | Catalog loader (content lives in `@bendyline/gilde`) |
| `@bendyline/gezel-knowledge` | The `.gezk` toolchain: compiler, verified archive reader, retrieval |
| `@bendyline/gezel-connectors-spectral` | Spawned Prismatic component host |
| `@bendyline/gezel-script-stdlib` | Standard gate-script library |
| `@bendyline/gezel-script-runtime` | Portable, capability-mediated script execution: the `ScriptExecutor` contract and the QuickJS-WASM executor |
| `@bendyline/gezel-mcp` | The stdio MCP server |
| `@bendyline/gezel-inference` | The on-device inference runtime |
| `@bendyline/gezel-capacitor` | On-device Gezel for iOS and Android apps, with prebuilt engines ([below](#the-capacitor-package-and-its-native-payload)) |
| `@bendyline/gezel-service` | `gezeld`, plus the bundled web UI and handboek |
| `@bendyline/gezel-cli` | The `gezel` command line |

The short names exist so `npx gezel-cli` works. Each lives in `packages/alias-*`
and holds one bin file that finds the scoped package's command through its
`package.json` and imports it:

| Package | Runs |
|---|---|
| `gezel-cli` | `gezel` from `@bendyline/gezel-cli` |
| `gezeld` | `gezeld` from `@bendyline/gezel-service` |
| `gezel-mcp` | `gezel-mcp` from `@bendyline/gezel-mcp` |

They read the manifest rather than importing an exported bin path because the
scoped versions published before the short names existed export no such path,
and a short name bootstrapped by hand depends on one of those.

Three tiers, and the tier is a property of the manifest, not a list:

- **Published** — the nineteen above.
- **Versioned but not published** — `packages/app` and `packages/vscode`.
  multi-semantic-release versions, tags and changelogs them, but they stay
  `private: true`, and [`scripts/publish-package.mjs`](../scripts/publish-package.mjs)
  skips anything private. They ship through electron-builder and the VS Code
  Marketplace.
- **Ignored** — `packages/ui`, `packages/eval-viewer`, `packages/sharp-compat`,
  `packages/ml-runtime`, and `evals`, excluded via `--ignore-packages`. The UI is not published
  separately because `packages/service/tsup.config.ts` stages
  `packages/ui/dist` into `packages/service/dist/ui/`; it ships inside the
  service tarball so a Node-only install can serve `gezel start --web` with
  nothing else to fetch. `sharp-compat` is ignored rather than left to its
  `private: true` flag: that flag stops the publish, but not the versioning —
  multi-semantic-release would give it a CHANGELOG and a git tag named
  literally `sharp@x.y.z`.

`packages/ml-runtime` is a private deployment-only dependency holder. Public
`@bendyline/gezel-service` installs keep Transformers/Kokoro as optional peers
so a cloud/headless npm consumer does not pay for two large native inference
stacks. The Electron and relocatable Node bundle builders deploy this private
package into their runtime trees, preserving the full local-embedding and TTS
feature set in complete distributions.

Adding or removing a published package means editing
[`scripts/published-packages.mjs`](../scripts/published-packages.mjs) and
nothing else. That module is the single registry the release scripts and the
contract tests all read — `check-package-consumers.mjs`,
`rehearse-npm-release.mjs`, `verify-published-npm-release.mjs` and
`tests/published/_packages.ts`. It is plain Node rather than TypeScript so
the release scripts can load it without any build.

The list used to be written out in all three places, and it drifted: `gezk`
reached two of them, the release rehearsal kept packing twelve tarballs, and
the consumer check it feeds rejected the set. `packageShape.test.ts` now fails
when any directory under `packages/` is neither published,
versioned-but-private, nor named in the release's `--ignore-packages`, so a new
package cannot go missing the same way.

## Versioning

Independent per package, via `multi-semantic-release` over Conventional
Commits — the same model as the sister repos `docblocks` and `squisq`. Each
package bumps only when its own files (or a dependency) change, gets its own
`CHANGELOG.md`, and is tagged `@bendyline/gezel-cli@1.2.3`.

The npm pipeline deliberately does **not** create GitHub Release objects for
those tags. npm already owns package discovery and provenance, while GitHub's
Releases page is reserved for distributable Electron and native-engine assets.
Because package versions are independent, one combined GitHub Release would
need an unrelated umbrella version and would duplicate the package changelogs.
The per-package git tags remain load-bearing for semantic-release's next-version
calculation.

This is unrelated to the Electron app's `1.YYDDD.RUN` scheme, which
[`scripts/stamp-version.mjs`](../scripts/stamp-version.mjs) mints in CI and
never commits.

Conventional Commits are not checked anywhere — no local git hook and no CI
job — but the messages are load-bearing, because every published version bump
derives from them: a commit whose subject has no type releases nothing.

### Which packages a release publishes

multi-semantic-release decides each package in two passes.

1. **Its own commits.** It lists the commits since the package's last tag that
   touched its directory (`git log <tag>..HEAD -- packages/<dir>`), and the
   commit analyzer reads their types: `feat` is a minor release, `fix` and
   `perf` a patch, a breaking change a major. Every file in the directory
   counts, shipped or not, and a squash merge gives the pull request's type to
   every package it touched.
2. **Its local dependencies.** A package then gets at least a patch whenever a
   local dependency releases, transitively, whether the edge is in
   `dependencies`, `devDependencies` or `peerDependencies` (`--deps.release`,
   default `patch`). Every local edge is `workspace:*`, which
   multi-semantic-release 3.1.0 always treats as needing a manifest update, so
   no edge is exempt. Its prepare step then writes every local dependency of a
   releasing package as an exact version.

The second pass is why a release carries packages whose only change is a
dependency pin, and they must ship. Published pins are exact, so a dependent
that stayed behind would keep pointing at the old sibling: `gezel-cli` would go
on installing the previous CLI, `script-stdlib` would bring a second copy of
`@bendyline/gezel-sdk` in beside the service's, and `app-sdk`'s exact peer
pin on the service would conflict with the new service. Some packages also
bundle a sibling (`sdk` bundles core), so a dependency release changes their
code as well.

The first pass is where a release can publish nothing new. A `fix:` commit
that touches only tests under `packages/gezk` releases `gezk` with identical
content, and through the pins every published package except `plugin-sdk` and
`connectors-spectral`, since everything else depends on `gezk` through core or
directly. Give a change that ships nothing a `test:`, `docs:` or `chore:`
type. A package `README.md` does ship, so a `fix:` that edits one is a real
release.

To preview the decision, run `pnpm exec multi-semantic-release --dry-run` on
`main`. To see what a candidate set would actually change on npm, pack it and
compare it with the registry:

```bash
node scripts/rehearse-npm-release.mjs --output <candidates>
npm pack @bendyline/gezk@latest --pack-destination <published>   # one per package
node scripts/compare-npm-release-content.mjs --candidates <candidates> --published <published>
```

[`compare-npm-release-content.mjs`](../scripts/compare-npm-release-content.mjs)
reports each package as `identical`, `pins-only` or `changed`, ignoring the
version. It compares manifests parsed, not as bytes: the rehearsal's plain
`pnpm pack` rewrites `workspace:*` through an async map that moves the
rewritten sibling pins to the end of their dependency map. The release does
not show that order, because multi-semantic-release has already replaced every
local range in place before pnpm packs, so a published manifest keeps the
source order.

### `GEZEL_VERSION` is stamped during `prepare`

The version a running install *reports* — `gezel --version`, `/api/health`
(which the UI renders as "development build" when it reads `0.0.0`), the system
diagnostics, the OpenAPI document, the MCP server handshake and the
engine-download User-Agent — all come from one source constant,
`GEZEL_VERSION` in [`packages/core/src/browser.ts`](../packages/core/src/browser.ts).
It is a literal rather than a read of `package.json` because core is bundled for
the browser and cannot reach for `node:module` at runtime.

The release workflow's `pnpm build` necessarily runs *before* semantic-release
computes any version, so without intervention every published package would
report `0.0.0` forever.
[`scripts/prepare-package.mjs`](../scripts/prepare-package.mjs) closes that gap:
`@semantic-release/exec`'s `prepareCmd` runs it once per package, it no-ops for
everything except `packages/core`, and for core it rebuilds core with the stamp
and asserts the rebuilt `dist` actually carries the version before the publish
step is allowed to pack it.

The stamp reaches the build, never the source. `prepare-package.mjs` passes it
as `GEZEL_RELEASE_VERSION` / `GEZEL_RELEASE_CONTENT_COMPAT`, and core's
`tsup.config.ts` swaps it into `browser.ts` as esbuild loads the file
([`scripts/core-version-stamp.mjs`](../scripts/core-version-stamp.mjs)). The
checkout therefore always reads `0.0.0`. It used to rewrite the source and
restore it afterwards, and the rehearsal below runs that inside `pnpm all` for
minutes: a commit made in that window carried `GEZEL_VERSION = '1.2.11'` to the
branch. The constants are typed `string` so the published declarations do not
promise `'0.0.0'`.

One stamp covers everything because core is `external` to every other package's
tsup build — the constant lives in core's `dist` alone and the rest import it.
The Electron release ([`scripts/stamp-version.mjs`](../scripts/stamp-version.mjs))
still rewrites the source, but only in a release job's throwaway checkout.

## `workspace:*` and why we publish with pnpm

Every cross-package dependency uses pnpm's workspace protocol. `npm publish`
does not understand it and would ship a manifest containing a literal
`"@bendyline/gezel": "workspace:*"` that no consumer can install.
`pnpm publish` rewrites it to the sibling's concrete version at pack time.

So `.releaserc.json` runs `@semantic-release/npm` with `npmPublish: false` —
it still writes the next version into `package.json` — and delegates the
actual publish to [`scripts/publish-package.mjs`](../scripts/publish-package.mjs)
through `@semantic-release/exec`.

Two consequences worth knowing:

- Published cross-deps end up **exact** (`1.4.0`, not `^1.4.0`). For packages
  this interdependent that is the coupling we want.
- Do not pass `--sequential-prepare`. `multi-semantic-release@3.1.0` has no
  such option; it silently forwards unknown flags to semantic-release. Its
  built-in synchronizer already serializes each package's prepare+publish pair,
  which means a dependent can be packed before a dependency has its new
  version on disk.

`multi-semantic-release` has its own prepare-time dependency rewrite and turns
local `workspace:*` declarations into concrete versions in the source
manifest. That source rewrite must not reach Git: it makes the workspace
lockfile stale and disables pnpm's explicit local-package contract.
[`scripts/prepare-package.mjs`](../scripts/prepare-package.mjs) therefore
records the computed manifest outside the checkout, then restores every local
dependency to `workspace:*` before `@semantic-release/git` commits
`package.json`. The same prepare hook runs
[`scripts/format-release-manifest.mjs`](../scripts/format-release-manifest.mjs)
after semantic-release's JSON writer so the committed manifest remains
Biome-compatible. [`scripts/publish-package.mjs`](../scripts/publish-package.mjs)
briefly materializes the recorded release manifest while `pnpm publish` packs
the tarball, then restores the workspace source even if publishing fails. This
preserves exact dependency versions without relying on sibling release order.
Plugin ordering in `.releaserc.json` is load-bearing: the exec prepare hook must
stay before the git plugin.

Both `pnpm validate` and the end of the npm release workflow run
`pnpm check:workspace-deps`; the post-release gate also performs a frozen,
lockfile-only install. If a release-tool update changes prepare behavior, the
release fails rather than leaving concrete sibling versions or a stale
`pnpm-lock.yaml` on `main`.

The alternative — plain semver cross-deps — was rejected because
`linkWorkspacePackages` defaults to `false` in pnpm 10/11, so pnpm would try
to resolve siblings from the registry during local development.

## Quality gates

The release workflow runs the same canonical gate as CI: `pnpm validate`.
**Add mandatory checks to that script, not to the workflow** — a release must
never be able to be laxer than a pull request.

The workflow runs that gate in phases on parallel runners
(`pnpm validate --phase=main`, `--phase=stability`, `--phase=e2e`), because
the serial chain outgrew one job's time limit. The split lives in
[`scripts/validate-workspace.mjs`](../scripts/validate-workspace.mjs), not in
the workflow. `stability` and `e2e` each take named steps of
`validate:unlocked` and run them after `pnpm build`, and `main` runs every
other step, so a new step needs no workflow edit. A plain `pnpm validate` still
runs the whole chain serially. Passing the same flag runs one release job's
share locally.

Two of its steps exist specifically for npm:

### `pnpm test:published`

[`tests/published/`](../tests/published/) — contract tests that run against
built `dist/` and against `npm pack` / `pnpm pack` output rather than `src/`.
They catch publishing-shape bugs no per-package suite can see:

- `workspaceProtocol.test.ts` packs for real and asserts no `workspace:` range
  survives into the tarball, and that no dependency is silently dropped.
- `packageShape.test.ts` asserts the manifest is publishable, that no source
  maps are packed, that a README ships, that every `exports`/`bin` target is
  in the tarball, and enforces a per-package packed-size budget.
- `criticalSubpaths.test.ts` resolves the specifiers that are looked up *by
  string* at runtime, from the package that resolves them and under the
  resolver it uses. `require.resolve` matches the `require` condition and
  `import.meta.resolve` matches `import`, so the mode matters — a package
  whose exports declare only `import` is unreachable from CJS.
- `bundledAssets.test.ts` asserts the service's `dist/ui/` and
  `dist/handboek-content/` trees exist, and that the native-release pin is not
  the placeholder.

### `pnpm check:packages`

[`scripts/check-package-consumers.mjs`](../scripts/check-package-consumers.mjs)
packs every published package, `npm install`s the tarballs into a throwaway
**non-pnpm, non-workspace** project, and then:

1. asserts every package resolved from a candidate tarball rather than the
   registry,
2. enforces a 950 MiB logical `node_modules` budget,
3. runs `npm audit --omit=dev` and fails on any high or critical advisory
   that [`scripts/npm-consumer-audit-allowlist.json`](../scripts/npm-consumer-audit-allowlist.json)
   does not accept with a reason and an expiry — stricter than the workspace
   gates, because a consumer cannot move past our exact pins; lower severities
   are printed, not failed, because
   workspace overrides never reach this graph and advisories arrive on
   npm's schedule rather than ours,
4. proves a clean-install macOS `node-pty` can spawn a shell,
5. imports every public subpath under plain node,
6. resolves the runtime-resolved specifiers,
7. runs the installed `gezel` binary, including `gezel run` against an
   already-running daemon, and a fresh-home `gezel run` with **no** mock
   provider, which must stop before any download and print CLI setup
   guidance (every other check here runs mocked, which is how a newcomer
   retry loop once shipped),
8. boots the installed `gezeld` with the mock provider, probes `/api/health`,
   creates a gezel, and asserts the daemon found its bundled UI and handboek.

Step 1 exists because a version pin cannot tell a candidate from its
already-published namesake. When the supplied tarball set was short one
package, npm quietly satisfied that dependency from registry.npmjs.org and
every later check validated the published package instead of the build. The
lockfile records a `file:` resolution for a tarball install, so that is what
gets checked.

The separate project is the whole point. Inside this repo everything resolves
through pnpm's workspace links and hoisted store, which hides two classes of
bug: a runtime dependency that is only present because a sibling hoisted it,
and a failure in the default native/prebuild chain (`node-pty`,
`@napi-rs/keyring`, `@resvg/resvg-js`, `sqlite-vec`, `playwright-core`) that
nothing else installs outside pnpm. The optional ML stack has separate complete-
bundle checks.

`GEZEL_CONSUMER_SKIP_DAEMON=1` skips step 8; `--keep` leaves the temp project
for inspection. `--tarball-dir <path>` skips packing and tests an existing set
of candidate artifacts byte-for-byte.

**Real models (opt-in, before a release).** A mocked `gezel run` cannot show
a model's own output reaching stdout: 1.2.4 printed local models' reasoning
and their text-form tool calls, while the saved messages were clean. Set
`GEZEL_CONSUMER_REAL_MODELS` to a comma list of `provider:model` thinking
models (for example `mlx:qwen3.5-0.8b-q4,mlx:gemma4-12b-q4,llama-cpp:qwen3.5-0.8b-q4`)
and `GEZEL_CONSUMER_REAL_MODEL_HOME` to a Gezel home kept for this check.
Prepare that home once with the installed CLI: `gezel --home <dir> model pull`
for each model (or `GEZEL_READONLY_MODEL_HOMES` to borrow them) and
`gezel --home <dir> native install --engine llama-server` for llama.cpp. The
check sets the home's provider and model, asks each one an arithmetic question,
and fails if stdout carries reasoning tags, tool-call markup or log records, or
if the saved reply has no reasoning (a model that did not think proves
nothing). The first MLX run in a fresh home builds its Python environment,
which takes several minutes.

### `pnpm check:npm-release-candidate`

[`scripts/rehearse-npm-release.mjs`](../scripts/rehearse-npm-release.mjs) is
part of the canonical `pnpm all` / `pnpm validate` gate and has a dedicated PR
job; the publish workflow reaches it through that same gate. `check:packages`
proves ordinary development packs; this proves the artifacts npm will actually
receive. It runs `prepare-package.mjs` with the current core version, exactly
as the release does, packs every published package, and hands the result to
`check-package-consumers.mjs` in strict release mode
(`--require-release-stamp`), which additionally asserts the installed
`gezel --version` matches.

It never writes `packages/core/src/browser.ts`, so committing while it runs is
safe. Core's `dist` is stamped for the duration, and a `finally` rebuilds it for
development. An interrupted run can leave that `dist` stamped; it is ignored by
Git, and the next `pnpm build` replaces it.

Consumer failures are saved with their error output under
`.cache/consumer-checks/` (override the JSON file path with
`GEZEL_CONSUMER_REPORT_PATH`). If the rehearsal fails, it repeats those errors
after the cleanup rebuild and prints the report path. A successful core
rebuild at the end of a failed rehearsal is cleanup, not the failing check.

## npm consumers get a lean dependency graph

`pnpm-workspace.yaml` pins transitive packages under `overrides`, and patches
`app-builder-lib`. **None of that reaches an npm consumer.** npm honours
`overrides` only from the root project being installed, never from inside a
dependency, so there is no manifest change that could carry these across — this
is a property of the package manager, not an oversight. `check:packages` is the
only gate that sees the graph npm actually resolves, which is why it installs
real tarballs into a non-pnpm project rather than trusting the workspace.

The local-ML packages are therefore optional peers of the published service.
The default npm install is the cloud/headless/runtime surface and carries no
Transformers, Sharp, or ONNX tree. The CLI's first-run workshop consumes the
service's capability-filtered audio catalog, so it does not offer or download
Kokoro when those peers are absent. Consumers that opt into in-process memory
embeddings or Kokoro TTS must use the safe root overrides documented in the
service README. Complete Electron and relocatable Node artifacts merge the
private `packages/ml-runtime` deployment, where workspace overrides do apply.

The app SDK uses the same optional-peer shape for a different reason. Its
`./host` entry starts a daemon in the consuming application's process, which
needs `@bendyline/gezel-service` — but the ordinary consumer only connects to a
daemon the user already runs and must not download ~37 MB to do it. The service
is therefore an optional peer, reached through a dynamic import that fires only
when an application actually hosts. `tests/published/optionalRuntime.test.ts`
pins both halves: the manifest shape, and that importing `./host` under a
resolver where the service is unavailable still works.

Two overrides in that complete distribution are worth knowing by name:

- **`sharp`.** In this workspace the slot is filled by
  [`packages/sharp-compat`](../packages/sharp-compat/README.md), a no-image stub.
  Transformers.js imports Sharp unconditionally from its Node bundle even though
  gezel only uses it for text embeddings and Kokoro TTS, and the stub keeps
  libvips and its dependency set out of the desktop app. An npm install resolves
  **real `sharp`** instead. That is accepted: it is strictly more capable than
  the stub, and gezel exposes no Transformers.js vision path for the difference
  to show up in. The cost is install weight and one more native prebuild in the
  chain — `sharp` publishes prebuilds for the mainstream platforms, so a
  platform without one falls back to building libvips. **The Electron app must
  stay on the stub**; the packaging guard that verifies it is deliberate.
- **`onnxruntime-node`,** pinned to the reviewed runtime used by the single
  Transformers.js 4.x line. Embeddings, image embeddings and Kokoro
  intentionally share that installation; two `onnxruntime-node` copies in a
  complete bundle are a packaging regression. `kokoro-js` 1.2.1 still declares
  Transformers.js `^3.5.1`, so a workspace override points it at the 4.x copy.

The `app-builder-lib` patch is electron-builder only and never reaches a
consumer at all.

## Native engine binaries

The CLI is a pure-JavaScript install. On-device inference needs native engines
(llama.cpp, stable-diffusion.cpp, whisper.cpp, ds4, uv), which are far too
large to ship in an npm tarball — the `linux-x64-cuda` archive alone is 756 MB
— so they are downloaded on demand and verified.

The chain of trust is anchored in the **published package**:
[`packages/inference/src/engines/native-manifest.ts`](../packages/inference/src/engines/native-manifest.ts)
bakes in `NATIVE_ENGINE_RELEASE` (the `native-v*` tag this build trusts) and
`SHA256SUMS_DIGEST` (the sha256 of that release's `SHA256SUMS` asset).
[`native-file-manifest.json`](../packages/inference/src/engines/native-file-manifest.json)
also pins every executable and loadable regular file after
signing/notarization. Schema 3 adds runtime source files an engine compiles at
startup, which no code signature covers (ds4's `metal/*.metal` on macOS),
pinned `hash-only` by extension; schema 2 manifests, from native releases up
to 0.1.55, still verify without them. Symlinks are recorded separately,
including their exact relative target text. Links may form ordinary internal SONAME chains,
but verification rejects absolute/escaping targets, dangling links, cycles,
unexpected links, and links that do not terminate at a pinned regular native
file. That second manifest lets a standalone CLI verify and reuse an Electron
installation's extracted payload without trusting metadata supplied by the
installation itself.
[`resolver.ts`](../packages/inference/src/engines/resolver.ts) verifies the
downloaded `SHA256SUMS` against that digest *before* trusting any per-asset
hash, then verifies each archive against its line. A tampered release cannot
swap a binary.

For macOS standalone payloads, the workflow's `notarytool submit --wait`
result must be `Accepted` before those exact signed bytes are hashed and
packed. Bare command-line binaries cannot carry a stapled ticket and `spctl`
cannot assess them as app bundles; `--macos-notarized` records the accepted
release provenance when the hashes are pinned. Electron reuse separately
assesses the signed/notarized parent `.app`. Electron packaging deliberately
does not re-sign `app.asar.unpacked/native-bin`: those Mach-O files were
already signed before their hashes were published. The outer app signature
still seals that tree, and release CI checks the per-file manifest in both the
staged tree and the extracted finished installer before running deep
signature verification.

`0.1.19` predates the per-file manifest, so its checked-in platform set is
intentionally empty and Electron reuse fails closed. The first native release
cut with the current workflow must be pinned with the command below before
publishing the corresponding CLI/Electron release.

**Whenever a `native-v*` release is published, re-pin before the next npm
release:**

```bash
node scripts/pin-native-release.mjs --latest --macos-notarized
git diff packages/inference/src/engines/native-manifest.ts
git diff packages/inference/src/engines/native-file-manifest.json
```

Review and commit; the PR is the audit trail. Never hand-edit the digest to
match a download — that defeats the mechanism. `bundledAssets.test.ts` fails
the release if the pin is still the all-zeros placeholder, because a
placeholder makes `isEnginePinned()` false and silently disables engine
download for everyone who installed from npm.

The Electron release workflow takes its native release from these pins rather
than from an input, so the installers and the npm packages always ship the same
engines. It refuses a native release without `NATIVE_FILE_MANIFESTS.json`, and
refuses to run when the two pinned source files disagree. The order is:
publish the native release, run the pin command, review and commit the pins,
then cut the Electron release.

A GitHub token is **optional** for engine download. `bendyline/gezel` is
public; a token, when present, only lifts GitHub's 60-request/hour
unauthenticated API rate limit.

## Trusted publishing (OIDC)

There is deliberately **no `NPM_TOKEN` or `NODE_AUTH_TOKEN`** in this repo.
`pnpm publish` exchanges the workflow's GitHub OIDC token for a short-lived
npm token. Three things make that work, and all three are load-bearing:

1. `id-token: write` on the `release` job.
2. `registry-url: 'https://registry.npmjs.org'` on `setup-node` — the exchange
   only fires when the resolved registry is exactly that host.
3. A trusted publisher registered on npmjs.com for each package.

### First publish (one time per package)

Trusted publishing can only be configured on a package that already exists, so
every package is bootstrapped by hand once.
[`scripts/check-npm-bootstrap.mjs`](../scripts/check-npm-bootstrap.mjs) runs
first in the release workflow and fails in seconds when a registered package
is not on npm yet — without it, the release fails inside
multi-semantic-release after the packages that depend on it have shipped. Two things about that hand-publish are
not obvious:

- **It must use `--no-provenance`.** Every manifest sets
  `publishConfig.provenance: true`, and npm can only mint provenance inside a
  supported CI with an OIDC token. From a workstation the publish fails without
  the flag. CI is unaffected — it wants provenance and can produce it. If a pnpm
  version ever stops forwarding the flag, `npm_config_provenance=false` in the
  environment does the same job.
- **The bootstrap version must stay below what semantic-release will compute.**
  With no `@bendyline/gezel*` git tags in the repo, multi-semantic-release treats
  every package as an initial release and computes `1.0.0`. Hand-publishing
  `1.0.0` makes the first CI release fail with `E403 cannot publish over the
  previously published version` — after some packages have already gone out.
  The bootstrap went out at `0.1.0`, so the first CI release is `1.0.0`.

1. From a clean `main`, with `pnpm validate` green, publish each package in
   dependency order with a granular npm token:
   ```bash
   pnpm build
   # No semantic-release run means no prepareCmd, so stamp GEZEL_VERSION by
   # hand — otherwise the bootstrap ships packages that report 0.0.0.
   (cd packages/core && node ../../scripts/prepare-package.mjs 0.1.0)
   for d in gezk core client sdk app-sdk plugin-sdk catalog knowledge \
            connectors-spectral script-stdlib mcp service cli; do
     (cd "packages/$d" && pnpm publish --access public --no-provenance --no-git-checks)
   done
   ```
   Order matters for installability, not for correctness of the manifests:
   `pnpm publish` rewrites `workspace:*` from the sibling's version **on disk**,
   so every package must already carry the bootstrap version before the first
   `publish` runs. `gezk` leads because `core` depends on it — it is the one
   published package with no workspace dependency of its own.
2. On npmjs.com, register a trusted publisher per package — npm's bulk
   trusted-publisher configuration makes that manageable:
   - repository: `bendyline/gezel`
   - workflow: `.github/workflows/publish-npm.yml`
   - environment: **none** (the release job configures none, so the trusted
     publisher must not require one)
3. Delete the token. Every release after this is token-free.
4. Confirm `@semantic-release/git` can push to `main`. `.releaserc.json` commits
   `CHANGELOG.md` and `package.json` back, and branch protection that rejects a
   `GITHUB_TOKEN` push fails the release *after* the packages are on npm.

### A package added after the bootstrap

A new published package is bootstrapped the same way, alone, and the rules above
still hold — `--no-provenance`, and a version below the `1.0.0` that
multi-semantic-release computes for a package with no git tag. `0.1.0` on the
manifest in the checkout is that version; leave it there and publish from the
package directory:

```bash
pnpm build
(cd packages/<new> && pnpm publish --access public --no-provenance --no-git-checks)
```

Two things decide whether that is the whole job:

- **Does it depend on a sibling?** If so, publish it after that sibling's
  current version is on npm — `pnpm publish` resolves `workspace:*` from the
  sibling's version **on disk**, which is `0.0.0` in a fresh checkout unless a
  release stamped it. `gezk` needed none of this: `zod` is its only dependency.
- **Does it import `GEZEL_VERSION`?** Only packages that do need
  `prepare-package.mjs` run by hand first, and only via `packages/core`.

Then register its trusted publisher on npmjs.com exactly as in step 2, and add
it to `PUBLISHED_PACKAGES` in
[`scripts/published-packages.mjs`](../scripts/published-packages.mjs) so every
shape and consumer gate covers it. Do that in the same change that creates the
package: `packageShape.test.ts` fails on an unaccounted-for workspace
directory, which is the reminder.
Its first CI release will be `1.0.0`, independent of where the other lines are.

### The unscoped short names

`gezel-cli`, `gezeld` and `gezel-mcp` bootstrapped the same way, each at the
`0.1.0` in its checkout manifest. They have no build and import nothing at
build time, so no `prepare-package.mjs` run is needed. Each depends on one
scoped package through `workspace:*`, which `pnpm publish` turns into that
package's version on disk: publish from a checkout whose `packages/cli`,
`packages/service` and `packages/mcp` versions are already on npm (a fresh
`main` is).

```bash
for d in alias-gezel-cli alias-gezeld alias-gezel-mcp; do
  (cd "packages/$d" && pnpm publish --access public --no-provenance --no-git-checks)
done
```

`npx gezel-cli` works as soon as that publish is visible. Register a trusted
publisher for each one, as in step 2 above. From then on multi-semantic-release
releases each short name with its scoped package: a release of
`@bendyline/gezel-cli` gives `gezel-cli` a patch release pinned to it. Their own
version lines start at `1.0.0` and do not match the scoped package's, and
`gezel --version` always reports the CLI's.

Two things about a new unscoped name only show up at the real publish:

- **npm can refuse the name.** A name that returns 404 and passes
  `npm publish --dry-run` can still fail with `E403 Package name too similar to
  existing packages`. On 2026-11-04 that refused `gezel` (similar to `gaze` and
  `level`) and `gezk` (similar to `gaze`), which is why the command line's short
  name is `gezel-cli`. A scoped name is exempt. The installed command is still
  `gezel`, because that comes from the package's `bin`, not its name.
- **A new package first appears as `0.0.0-stage`,** a placeholder npm writes
  while it processes the publish. `latest` points at it until the real version
  lands, a minute to several minutes later, and until then `npx <name>` fails
  with `could not determine executable to run`. That is not a broken publish.

### The Capacitor package and its native payload

`@bendyline/gezel-capacitor` is the one package whose tarball carries prebuilt
engines: the `gezel-mobile-<version>-{ios,android}.tar.gz` SDKs of the native
release pinned in `native-manifest.ts`. They are never committed, and its
`prepack` stages them through
[`scripts/stage-capacitor-native.mjs`](../scripts/stage-capacitor-native.mjs),
so every path that packs it works unattended. The trust root is the desktop
engine resolver's: the pinned `SHA256SUMS_DIGEST` vouches for `SHA256SUMS`, which
vouches for each archive. A build someone staged on purpose (`0.0.0-ci.*` in
`mobile-native.yml`) is left alone, except by a release.

**A release ships the pinned native release as built, and validates against
it.** `native/runtime` moving past the pin is normal: a native release is cut
from a merged commit, and those changes reach the package when the pin moves.
`prepack` compares each SDK's recorded `sources` with the checkout and reports
the drift; it never refuses it, in a release or out of one. What would break an
app is the plugin (`ios/Sources`, `android/src`), which the app compiles against
the staged runtime, naming runtime API that runtime lacks. Every pack runs
`verifyPluginRuntimeApi` for that: it reads the pinned release's public
declarations (the iOS SDK's Swift sources, the Android `-sources.jar`), finds
the public names `native/runtime` has added since, and refuses a plugin whose
code (not its comments or strings) uses one. Reach newer API in a way that
still works without it, as the plugin does for `GezelRuntimeWillRunModel`.

`publish-npm.yml` runs `stage-capacitor-native.mjs --release` before anything
publishes. It replaces any staged build that is not the pin, verifies the pinned
payloads against `SHA256SUMS`, and runs the checks above.
`publish-package.mjs` sets `GEZEL_CAPACITOR_RELEASE=1` for the publish itself,
which makes `prepack` insist on both speech runtimes (below).

The offline speech runtime ships the same way: since the release after
native-v0.1.57, each native release also carries
`gezel-mobile-<version>-speech-{ios,android}.tar.gz`, and `prepack` stages them
as `native/speech-{ios,android}`. Offline speech is what apps such as DocBlocks
take this package for, so the release gate refuses to publish without both
runtimes, or with one from another release. An ordinary pack against a pin
that predates them only warns, and its `status()` reports speech unavailable.
See the package README's "Offline speech".

Bootstrap it like any other package, at the `0.1.0` in its manifest. It depends
on `packages/core` and `packages/app-sdk` through `workspace:*`, so publish from
a checkout whose versions of those are on npm, and only after checking that the
build imports nothing newer than them:

```bash
pnpm build
(cd packages/capacitor && pnpm publish --access public --no-provenance --no-git-checks)
```

### `ENONPMTOKEN` is not a missing secret

If a release fails with `No npm token specified.`, the trusted-publisher
config on npmjs.com has been dropped or no longer matches this workflow. Note
that it is keyed on the workflow **file path** — renaming
`publish-npm.yml` breaks publishing until the trusted publishers are
re-pointed.

## Cutting a release

1. Make sure `main` is green and the native pin is current
   (`node scripts/pin-native-release.mjs --latest`).
2. Dispatch **Publish npm packages** from the Actions tab. Tick `dry_run` for
   a rehearsal — it runs every gate and computes versions, publishes nothing.
3. The `verify` job runs the canonical gate plus the license, SBOM and
   vulnerability audits. The `release` job publishes.
4. Confirm on npmjs.com that the new versions carry a provenance badge.

After publishing, `verify-published-npm-release.mjs` downloads every exact
version in the shared package list and runs the strict consumer checks.
It checks each artifact independently, refreshes npm metadata every 15 seconds,
and allows up to 40 minutes of wall-clock time. Artifacts that become available
are retained while slower siblings remain pending, so large packages are not
re-downloaded on every pass. [npm scans new package versions before making them
installable](https://github.blog/changelog/2026-07-28-npm-publish-time-malware-scanning-and-dual-use-metadata/);
the usual delay is about five minutes, but npm documents 15-minute or longer
scans at peak times or for some package contents and sizes. The verifier
therefore reports the exact versions still pending instead of treating the
first `ETARGET` as the whole result. An exhausted deadline or failed consumer
check still fails the release job.

Locally, `pnpm exec multi-semantic-release --dry-run` shows the computed
versions and notes without touching anything.

## Toolchain fragility

`multi-semantic-release` sits on a fragile seam: it depends on
`semantic-release` through an open `>=19.0.5` range with no peerDependency,
and it deep-imports the private path `semantic-release/lib/get-config`,
**swallowing failure into stubs behind a `console.debug`**. A release would
then complete having published nothing, with no error.

[`scripts/check-release-toolchain.mjs`](../scripts/check-release-toolchain.mjs)
(`pnpm check:release-toolchain`, run by local validation, PR CI, and the release
workflow) turns both into loud, early failures: it requires exact pins for both
packages and asserts the deep import still resolves. If it ever breaks for real,
the maintained successor is `@anolilab/multi-semantic-release`, which
additionally has explicit support for pnpm's workspace protocol.

## Known gaps for npm installs

These work in the desktop app because the Electron supervisor sets them up,
and are not yet handled for a bare `npm i -g`:

- **`GEZEL_PNPM_PATH` / `GEZEL_NODE_PATH` are unset.** The Copilot
  system-toolset installer falls back to whatever `pnpm` is on `PATH`, and the
  sandbox runner falls back to `process.execPath`.
- ~~**The `node-pty` exec-bit fixup does not run.**~~ Handled. The service used
  to repair `spawn-helper`'s exec bit from its own `postinstall`, which npm
  11.16 stopped running by default (install scripts now sit behind
  `allowScripts` approval, as do `--ignore-scripts` and equivalent corporate
  policies). The repair moved to `ensureNodePtyExecutable()` in
  [`node-pty-permissions.ts`](../packages/service/src/node-pty-permissions.ts),
  called once per process immediately before the first PTY spawn — so it works
  on every install path and costs one `stat` when the bit is already correct.
  Dropping that hook left **no published gezel package running code on
  install**, which [`packageShape.test.ts`](../tests/published/packageShape.test.ts)
  now enforces. Root `postinstall` still runs
  [`scripts/fix-node-pty-perms.mjs`](../scripts/fix-node-pty-perms.mjs) for the
  pnpm workspace, where hardlinking strips the bit.
- **First-run bootstrap is eager.** On first daemon boot the service
  background-downloads Playwright/Chromium, and the on-device bootstrap starts
  pulling a Gemma 4 GGUF unless a cloud provider was chosen. For an npm
  install this should be opt-in.
