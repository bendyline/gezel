# Store distribution

Gezel ships on three channels. This document is about the two newest ones and,
mostly, about how they differ from the one you already know.

| Channel | Artifact | Delivery | Service |
|---|---|---|---|
| Direct download | NSIS `.exe`, `.pkg`, `.deb`/`.rpm` | our updater | registers a machine service |
| Microsoft Store | `.appx` (MSIX) | the Store | per-user only |
| Mac App Store | `.pkg` (MAS) | the Store | per-user only, sandboxed |

The store builds exist **alongside** the direct download, never instead of it.
A machine can have both, and the interesting design work is what happens then.

## The two rules everything follows from

**1. A store build may not download or install executable code.** Apple states
it as guideline 2.4.5 (self-contained; do not install code outside the bundle);
Microsoft's device-abuse policy says effectively the same. Model weights and
`.gezk` catalogs are *data* and stay legal — that distinction is what makes the
packed-in model pack possible.

**2. A store build may connect to another install's daemon, but never manage
it.** It did not spawn that process, cannot signal it under the macOS sandbox,
and the other install's update schedule is not its to interfere with.

Everything below is a consequence of one of those.

## The distribution profile

`resolveDistributionProfile()` in
[packages/core/src/distribution/profile.ts](../packages/core/src/distribution/profile.ts)
is a deliberate **sibling** of `resolveSecurityPolicy`, not a capability inside
it. The security policy gates *model agency* and explicitly exempts
user-initiated installs; the distribution profile has to bind those too — a
store build may not download an engine no matter who asked.

It reaches the service and the MCP child through `GEZEL_DISTRIBUTION_PROFILE`,
stamped by `main.ts` from the build marker. That direction is one-way on
purpose: the environment carries the answer *downward*, and
[store-build.ts](../packages/app/src/store-build.ts) never reads it back, so no
inherited variable can talk a store build out of its own restrictions. A
non-store build deletes an inherited `store` for the mirror-image reason.

Nine enforcement points, each returning a reason string rather than a bare
refusal: the Playwright bootstrap, the Copilot SDK install, engine downloads,
`ensureVenv`, `requestNpmInstalls`, the `npm_install` tool registration (hidden
from the schema entirely — a model that sees a tool reaches for it), Copilot's
`canInstall`, the Ollama emulation listener, and the config route that pins it
off.

## Coexistence: the store ladder

`resolveMode` diverts to the store ladder **before** system-service and
local-adopt rather than adding a branch inside them. Every branch below that
point waits on, stops, or spawns a daemon, and `local-adopt` specifically
SIGTERMs a version-mismatched one and respawns it — against a direct-download
install that is one product killing another's service.

Finding the other daemon
([store-rendezvous.ts](../packages/app/src/supervisor/store-rendezvous.ts))
differs by platform because the isolation does:

- **macOS** — the MAS build cannot see `~/.gezel/runtime/` at all (outside its
  container, and 0600 besides). Both builds declare the same App Group, and the
  direct-download daemon mirrors its discovery metadata there from inside
  `writeRuntime` — inside, because the client token rotates on every service
  start and anything copying later would publish a stale one. The pid is
  deliberately **not** mirrored: liveness is the health probe's answer, and
  having the number would only invite code that acts on it.
- **Windows** — a full-trust MSIX reads the real `%USERPROFILE%` (MSIX
  virtualizes AppData and the registry, not the profile root), so the canonical
  runtime directory is readable directly.

Judging it ([store-compat.ts](../packages/app/src/supervisor/store-compat.ts))
uses the `apiCompat` range on `/api/health`, **never version equality**. The
two channels ship on different schedules, so a version difference is the normal
case; an exact-match check would send every store user to a private daemon the
day either side shipped a patch. A daemon with no `apiCompat` predates the
handshake and is declined — absence is a verdict, not silence.

Anything that fails lands in the same place: the store build runs **its own**
service, on a container-scoped home, and says so once in a notice shaped around
that outcome rather than around the failure. Nothing is broken; the two
installs simply keep separate services, and a model resident in one is not
reused by the other.

## Packaging

Both store configs `extends:` the base so `files`, `asarUnpack`, `afterPack`
and the icon stay in one place. They are separate files rather than blocks in
the base config because the audited contract tests pin things that must stay
true of the Developer ID build — mac targets exactly `['pkg','zip']`, and
`com.apple.security.app-sandbox` forbidden in `entitlements.mac.plist`.

### The signIgnore inversion

This is the single most confusing thing in the MAS lane, so it is worth stating
plainly. Both configs list the same paths — `native-bin/`, the bundled node,
DuckDB — for **opposite** reasons:

- The base config skips them to **preserve** each vendor's Developer ID
  signature. Re-signing would substitute our attestation for theirs.
- The MAS config skips them to **preserve our own re-signing**. Under the
  sandbox every Mach-O must carry our Apple Distribution identity and the child
  inherit entitlements, or it will not launch.

### Two orderings that are load-bearing

Both have a failure mode that stays invisible until a reviewer's machine, and
both are pinned by
[store-packaging-contract.test.mjs](../scripts/store-packaging-contract.test.mjs):

1. **Native provenance is verified before re-signing.** The manifest attests to
   the bytes the native release published; re-signing changes them. Verifying
   afterwards would only assert our own bytes back to us.
2. **Re-signing runs after `pnpm build:packaged` and before electron-builder.**
   tsup's `onSuccess` hook re-runs `fetch-node` / `fetch-duckdb`, which re-stage
   those bundles from their vendor downloads and rewrite `sha256.txt`. Signing
   earlier is silently undone — the build stays green and ships vendor-signed
   binaries whose children cannot launch, with nothing anywhere mentioning
   signatures. `mas-resign-payload.mjs` refuses to run before that point rather
   than relying on the ordering being remembered.

### Running in place

A MAS build resolves node, pnpm, DuckDB and the service tree **where they
shipped** instead of extracting them into the home directory
([run-in-place.ts](../packages/app/src/supervisor/run-in-place.ts)). Copying an
executable out of the bundle to run it is the shape 2.4.5 describes, and under
the sandbox `$HOME` is the container anyway, so the copy buys no sharing.

The service tarball exists for a *Windows* reason — Defender synchronously
scans each of ~100k extracted files, the difference between a thirty-minute
install and a few seconds — which does not apply on macOS. `pnpm deploy`
already leaves the complete tree at `dist/service-bundle/` on its way to
producing the tarball, so the MAS lane ships that. Windows MSIX keeps
extract-to-home: full trust, a real profile, and sharing with an
npm-installed daemon that is worth keeping.

## Building

Both lanes are `workflow_dispatch` only and produce **draft artifacts** that a
human downloads and uploads to the store console. Nothing publishes itself.

- [release-msix.yml](../.github/workflows/release-msix.yml) needs **no signing
  secrets** — the Store signs on ingest, and an Authenticode signature applied
  here would be rejected. An opt-in `installSmoke` input self-signs a *copy*,
  installs it, and launches it once with the same sentinel the NSIS smoke uses.
- [release-mas.yml](../.github/workflows/release-mas.yml) needs the Apple
  Distribution and 3rd Party Mac Developer Installer identities plus a
  provisioning profile, and **no notarization secrets** — a MAS package is
  never notarized or stapled.

There is no CI smoke for the MAS build, and that is a real gap rather than an
oversight: an App Store-provisioned app cannot launch on a runner, because the
profile names no machine there. Test on a real Mac with the `mas-dev` target
and a development profile at
`packages/app/build-store/Gezel_MASDev.provisionprofile`.

## Before a first submission

Neither lane can be submitted from a clean checkout; these are deliberately
loud rather than plausible defaults.

- **Microsoft Store** — reserve the identity in Partner Center and replace the
  `REPLACE_WITH_PARTNER_CENTER_*` placeholders; author `assets/appx/` tile art
  (electron-builder substitutes stock images rather than failing); settle the
  VC++ runtime question for the engines (app-local CRT DLLs are the likely
  answer, since the VCLibs desktop framework package is deprecated) and
  validate on a clean Windows VM.
- **Mac App Store** — register the bundle ID and the App Group in App Store
  Connect, and confirm the provisioning profile carries the App Groups
  capability. Without it the app installs, runs, and silently never finds a
  direct-download daemon.
- **Both** — pin real `url` + `sha256` values in
  [model-pack.json](../packages/app/model-pack.json). Placeholder entries are a
  hard build error, not a warning.

## Not done yet

- **Frozen Python / MLX.** MAS v1 ships llama.cpp Metal as the only chat
  engine. MLX today is uv → venv → pip-installed wheels, all runtime downloads.
  The eventual answer is either a frozen bundled environment or a
  `gezel-mlx-server` built on Apple's MLX Swift — the latter would also remove
  the venv cold start for every Mac user, store or not.
- **Apple-hosted Background Assets.** The model pack currently ships in-bundle.
  Moving it to asset packs (200 GB per app on Apple's CDN, versioned
  independently of the build) would stop app updates re-shipping unchanged
  weights.
