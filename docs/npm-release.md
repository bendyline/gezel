# npm release

How gezel's JavaScript packages get to npm. For the desktop installers see
[RELEASE.md](../RELEASE.md); the two pipelines are independent and share no
version line.

## What ships

Eleven packages, all under the `@bendyline` scope, all public API under semver:

| Package | What it is |
|---|---|
| `@bendyline/gezel` | Core types, Zod schemas, path helpers, gezel-markdown parser |
| `@bendyline/gezel-client` | Typed HTTP client for the daemon |
| `@bendyline/gezel-sdk` | The preferred extension surface |
| `@bendyline/gezel-app-sdk` | Embedding helpers for host applications |
| `@bendyline/gezel-plugin-sdk` | Legacy extension surface, kept for compatibility |
| `@bendyline/gezel-catalog` | Catalog loader (content lives in `@bendyline/gilde`) |
| `@bendyline/gezel-connectors-spectral` | Spawned Prismatic component host |
| `@bendyline/gezel-script-stdlib` | Standard gate-script library |
| `@bendyline/gezel-mcp` | The stdio MCP server |
| `@bendyline/gezel-service` | `gezeld`, plus the bundled web UI and handboek |
| `@bendyline/gezel-cli` | The `gezel` command line |

Three tiers, and the tier is a property of the manifest, not a list:

- **Published** — the eleven above.
- **Versioned but not published** — `packages/app` and `packages/vscode`.
  multi-semantic-release versions, tags and changelogs them, but they stay
  `private: true`, and [`scripts/publish-package.mjs`](../scripts/publish-package.mjs)
  skips anything private. They ship through electron-builder and the VS Code
  Marketplace.
- **Ignored** — `packages/ui`, `packages/eval-viewer`, `evals`, excluded via
  `--ignore-packages`. The UI is not published separately because
  `packages/service/tsup.config.ts` stages `packages/ui/dist` into
  `packages/service/dist/ui/`; it ships inside the service tarball so a
  Node-only install can serve `gezel start --web` with nothing else to fetch.

Adding or removing a published package means editing
[`tests/published/_packages.ts`](../tests/published/_packages.ts) and the
`PUBLISHED` list in
[`scripts/check-package-consumers.mjs`](../scripts/check-package-consumers.mjs).

## Versioning

Independent per package, via `multi-semantic-release` over Conventional
Commits — the same model as the sister repos `docblocks` and `squisq`. Each
package bumps only when its own files (or a dependency) change, gets its own
`CHANGELOG.md`, and is tagged `@bendyline/gezel-cli@1.2.3`.

This is unrelated to the Electron app's `1.YYDDD.RUN` scheme, which
[`scripts/stamp-version.mjs`](../scripts/stamp-version.mjs) mints in CI and
never commits.

Conventional Commits are enforced by the `commitlint` job in
[quality.yml](../.github/workflows/quality.yml) on pull requests **and** on
pushes to `main`. There is no local git hook, deliberately — but the messages
are load-bearing, because every published version bump derives from them.

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

- `--sequential-prepare` is **required**, not cosmetic. pnpm resolves
  `workspace:*` against a sibling's *current* version, so a dependency must
  have its new version written before a dependent is packed.
- Published cross-deps end up **exact** (`1.4.0`, not `^1.4.0`). For packages
  this interdependent that is the coupling we want.

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
packs all eleven packages, `npm install`s the tarballs into a throwaway
**non-pnpm, non-workspace** project, and then:

1. imports every public subpath under plain node,
2. resolves the runtime-resolved specifiers,
3. runs the installed `gezel` binary,
4. boots the installed `gezeld` with the mock provider, probes `/api/health`,
   creates a gezel, and asserts the daemon found its bundled UI and handboek.

The separate project is the whole point. Inside this repo everything resolves
through pnpm's workspace links and hoisted store, which hides two classes of
bug: a runtime dependency that is only present because a sibling hoisted it,
and a failure in the native prebuild chain (`node-pty`, `@napi-rs/keyring`,
`@resvg/resvg-js`, `sqlite-vec`, `onnxruntime-node`, `kokoro-js`,
`playwright-core`) that nothing else installs outside pnpm.

`GEZEL_CONSUMER_SKIP_DAEMON=1` skips step 4; `--keep` leaves the temp project
for inspection.

## Native engine binaries

The CLI is a pure-JavaScript install. On-device inference needs native engines
(llama.cpp, stable-diffusion.cpp, whisper.cpp, ds4, uv), which are far too
large to ship in an npm tarball — the `linux-x64-cuda` archive alone is 756 MB
— so they are downloaded on demand and verified.

The chain of trust is anchored in the **published package**:
[`packages/service/src/engines/native-manifest.ts`](../packages/service/src/engines/native-manifest.ts)
bakes in `NATIVE_ENGINE_RELEASE` (the `native-v*` tag this build trusts) and
`SHA256SUMS_DIGEST` (the sha256 of that release's `SHA256SUMS` asset).
[`resolver.ts`](../packages/service/src/engines/resolver.ts) verifies the
downloaded `SHA256SUMS` against that digest *before* trusting any per-asset
hash, then verifies each archive against its line. A tampered release cannot
swap a binary.

**Whenever a `native-v*` release is published, re-pin before the next npm
release:**

```bash
node scripts/pin-native-release.mjs --latest      # or native-v0.1.19
git diff packages/service/src/engines/native-manifest.ts
```

Review and commit; the PR is the audit trail. Never hand-edit the digest to
match a download — that defeats the mechanism. `bundledAssets.test.ts` fails
the release if the pin is still the all-zeros placeholder, because a
placeholder makes `isEnginePinned()` false and silently disables engine
download for everyone who installed from npm.

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

Trusted publishing can only be configured on a package that already exists.

1. Publish each package once by hand with a granular npm token:
   ```bash
   pnpm build
   pnpm --filter @bendyline/gezel publish --access public
   # …repeat for the other ten
   ```
2. On npmjs.com, register a trusted publisher per package — npm's bulk
   trusted-publisher configuration makes eleven manageable:
   - repository: `bendyline/gezel`
   - workflow: `.github/workflows/publish-npm.yml`
   - environment: **none** (the release job configures none, so the trusted
     publisher must not require one)
3. Delete the token. Every release after this is token-free.

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
- **The `node-pty` exec-bit fixup does not run.** Root `postinstall` runs
  [`scripts/fix-node-pty-perms.mjs`](../scripts/fix-node-pty-perms.mjs) because
  pnpm hardlinking strips the exec bit from `spawn-helper`. That is
  pnpm-store-specific and does not apply to an npm-installed CLI.
- **First-run bootstrap is eager.** On first daemon boot the service
  background-downloads Playwright/Chromium, and the on-device bootstrap starts
  pulling a Gemma 4 GGUF unless a cloud provider was chosen. For an npm
  install this should be opt-in.
