# npm release

How gezel's JavaScript packages get to npm. For the desktop installers see
[RELEASE.md](../RELEASE.md); the two pipelines are independent and share no
version line.

## What ships

Thirteen packages, all under the `@bendyline` scope, all public API under semver:

| Package | What it is |
|---|---|
| `@bendyline/gezk` | The `.gezk` knowledge-catalog format: schemas, ids, references, quantization, DDL, signing (no gezel dependency) |
| `@bendyline/gezel` | Core types, Zod schemas, path helpers, gezel-markdown parser |
| `@bendyline/gezel-client` | Typed HTTP client for the daemon |
| `@bendyline/gezel-sdk` | The preferred extension surface |
| `@bendyline/gezel-app-sdk` | Embedding helpers for host applications |
| `@bendyline/gezel-plugin-sdk` | Legacy extension surface, kept for compatibility |
| `@bendyline/gezel-catalog` | Catalog loader (content lives in `@bendyline/gilde`) |
| `@bendyline/gezel-knowledge` | The `.gezk` toolchain: compiler, verified archive reader, retrieval |
| `@bendyline/gezel-connectors-spectral` | Spawned Prismatic component host |
| `@bendyline/gezel-script-stdlib` | Standard gate-script library |
| `@bendyline/gezel-mcp` | The stdio MCP server |
| `@bendyline/gezel-service` | `gezeld`, plus the bundled web UI and handboek |
| `@bendyline/gezel-cli` | The `gezel` command line |

Three tiers, and the tier is a property of the manifest, not a list:

- **Published** — the thirteen above.
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

Conventional Commits are enforced by the `commitlint` job in
[quality.yml](../.github/workflows/quality.yml) on pull requests **and** on
pushes to `main`. There is no local git hook, deliberately — but the messages
are load-bearing, because every published version bump derives from them.

### `GEZEL_VERSION` is stamped during `prepare`

The version a running install *reports* — `gezel --version`, `/api/health`
(which the UI renders as "development build" when it reads `0.0.0`), the system
diagnostics, the OpenAPI document, the MCP server handshake and the
engine-download User-Agent — all come from one source constant,
`GEZEL_VERSION` in [`packages/core/src/index.ts`](../packages/core/src/index.ts).
It is a literal rather than a read of `package.json` because core is bundled for
the browser and cannot reach for `node:module` at runtime.

The release workflow's `pnpm build` necessarily runs *before* semantic-release
computes any version, so without intervention every published package would
report `0.0.0` forever.
[`scripts/prepare-package.mjs`](../scripts/prepare-package.mjs) closes that gap:
`@semantic-release/exec`'s `prepareCmd` runs it once per package, it no-ops for
everything except `packages/core`, and for core it stamps the constant, rebuilds
core, and asserts the rebuilt `dist` actually carries the version before the
publish step is allowed to pack it.

One stamp covers everything because core is `external` to every other package's
tsup build — the constant lives in core's `dist` alone and the rest import it.
Like the Electron stamp, the rewritten source is deliberately **not** committed:
`.releaserc.json`'s git assets are `CHANGELOG.md` and `package.json` only, and
each release re-stamps from a `0.0.0` checkout.

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
packs all thirteen packages, `npm install`s the tarballs into a throwaway
**non-pnpm, non-workspace** project, and then:

1. asserts every package resolved from a candidate tarball rather than the
   registry,
2. enforces an 800 MiB logical `node_modules` budget,
3. runs `npm audit --omit=dev --audit-level=high`,
4. proves a clean-install macOS `node-pty` can spawn a shell,
5. imports every public subpath under plain node,
6. resolves the runtime-resolved specifiers,
7. runs the installed `gezel` binary, including `gezel run` against an
   already-running daemon,
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

### `pnpm check:npm-release-candidate`

[`scripts/rehearse-npm-release.mjs`](../scripts/rehearse-npm-release.mjs) is
the last gate before a publish, and the publish workflow runs it as its own
step after `pnpm validate`. `check:packages` proves ordinary development packs;
this proves the artifacts npm will actually receive. It stamps
`packages/core/src/index.ts` with the current core version exactly as
`prepare-package.mjs` does at release time, packs every published package, and
hands the result to `check-package-consumers.mjs` in strict release mode
(`--require-release-stamp`), which additionally asserts the installed
`gezel --version` matches.

The stamped constant must never reach a commit, so the script restores the
source and rebuilds core in a `finally`. It refuses to start unless
`GEZEL_VERSION` and `GEZEL_CONTENT_COMPAT` are both at their development
`0.0.0`, and verifies they are again afterwards. Restoring "whatever was there
at start-up" is not enough: an interrupted earlier run leaves the file already
stamped, and a faithful restore then writes the release version straight back
while reporting success.

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
  Transformers.js 3.x line. Embeddings and Kokoro intentionally share that
  installation; two `onnxruntime-node` copies in a complete bundle are a
  packaging regression.

The `app-builder-lib` patch is electron-builder only and never reaches a
consumer at all.

## Native engine binaries

The CLI is a pure-JavaScript install. On-device inference needs native engines
(llama.cpp, stable-diffusion.cpp, whisper.cpp, ds4, uv), which are far too
large to ship in an npm tarball — the `linux-x64-cuda` archive alone is 756 MB
— so they are downloaded on demand and verified.

The chain of trust is anchored in the **published package**:
[`packages/service/src/engines/native-manifest.ts`](../packages/service/src/engines/native-manifest.ts)
bakes in `NATIVE_ENGINE_RELEASE` (the `native-v*` tag this build trusts) and
`SHA256SUMS_DIGEST` (the sha256 of that release's `SHA256SUMS` asset).
[`native-file-manifest.json`](../packages/service/src/engines/native-file-manifest.json)
also pins every executable and loadable regular file after
signing/notarization. Schema 2 records symlinks separately, including their
exact relative target text. Links may form ordinary internal SONAME chains,
but verification rejects absolute/escaping targets, dangling links, cycles,
unexpected links, and links that do not terminate at a pinned regular native
file. That second manifest lets a standalone CLI verify and reuse an Electron
installation's extracted payload without trusting metadata supplied by the
installation itself.
[`resolver.ts`](../packages/service/src/engines/resolver.ts) verifies the
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
git diff packages/service/src/engines/native-manifest.ts
git diff packages/service/src/engines/native-file-manifest.json
```

Review and commit; the PR is the audit trail. Never hand-edit the digest to
match a download — that defeats the mechanism. `bundledAssets.test.ts` fails
the release if the pin is still the all-zeros placeholder, because a
placeholder makes `isEnginePinned()` false and silently disables engine
download for everyone who installed from npm.

The Electron release workflow requires its `nativeTag` to match both pinned
source files and refuses a native release without `NATIVE_FILE_MANIFESTS.json`.
This makes the order explicit: publish the native release, run the pin command,
review and commit the pins, then cut the Electron release.

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
the thirteen are bootstrapped by hand once. Two things about that hand-publish are
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
   trusted-publisher configuration makes thirteen manageable:
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
It refreshes npm metadata on each attempt and retries every 15 seconds for
five minutes (21 attempts, plus npm request time), since npm can acknowledge
a publish before the version becomes readable. Exhausted download retries or
failed consumer checks still fail the release job.

Locally, `pnpm exec multi-semantic-release --dry-run` shows the computed
versions and notes without touching anything.

## Toolchain fragility

`multi-semantic-release` sits on a fragile seam: it depends on
`semantic-release` through an open `>=19.0.5` range with no peerDependency,
and it deep-imports the private path `semantic-release/lib/get-config`,
**swallowing failure into stubs behind a `console.debug`**. A release would
then complete having published nothing, with no error.

[`scripts/check-release-toolchain.mjs`](../scripts/check-release-toolchain.mjs)
(`pnpm check:release-toolchain`, run in the release workflow) turns both into
loud, early failures: it requires exact pins for both packages and asserts the
deep import still resolves. If it ever breaks for real, the maintained
successor is `@anolilab/multi-semantic-release`, which additionally has
explicit support for pnpm's workspace protocol.

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
