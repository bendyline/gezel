# Releasing Gezel

This is the maintainer runbook for the desktop release defined by [`.github/workflows/release-electron.yml`](.github/workflows/release-electron.yml). The workflow is the source of truth; update this document in the same change whenever its inputs, gates, artifacts, or publishing behavior change.

End users should download installers from [GitHub Releases](https://github.com/bendyline/gezel/releases), not follow this runbook.

> **Publishing the npm packages is a separate pipeline** — see [docs/npm-release.md](docs/npm-release.md). It has its own workflow ([`publish-npm.yml`](.github/workflows/publish-npm.yml)), its own version line (real semver per package, from Conventional Commits, rather than the `1.YYDDD.RUN` scheme below), and shares nothing with this one except the `native-v*` releases both depend on. Re-pin the native release with `node scripts/pin-native-release.mjs --latest` before either.

## Release contract

The **Release Electron App** workflow is manually dispatched and always creates a **draft** GitHub Release. It cannot publish a release. Publishing is a separate maintainer action after smoke testing.

The workflow fails closed:

- `nativeTag` is required and must match `native-vX.Y.Z` (an optional version suffix is allowed).
- The referenced native release must already be published, must not be a draft, and must contain every platform/variant asset plus `SHA256SUMS` expected by preflight.
- Every Windows signing and Apple signing/notarization secret listed below must be present before any build begins.
- Quality, packaging, signature, notarization, and artifact-presence failures stop the release.
- An already-published release with the generated tag is never modified.

The production workflow never falls back to unsigned Windows or macOS installers. Unsigned artifacts made by local developer commands are smoke-test outputs, not release candidates.

## Release outputs

Versions use `1.YYDDD.RUN`, where `YY` is the two-digit year, `DDD` is the zero-padded UTC day of year, and `RUN` is the GitHub Actions run number. For example, `1.26109.42` is run 42 on 2026-04-19. [`scripts/stamp-version.mjs`](scripts/stamp-version.mjs) stamps the version only in CI; committed package versions remain `0.0.0`.

For version `<version>`, the draft release contains:

| Platform | Architectures | Production artifacts | Release security |
| --- | --- | --- | --- |
| Windows | x64 | `Gezel-<version>-x64.exe`, blockmap, `latest.yml` | NSIS installer and installed application are Authenticode-signed through Azure Trusted Signing |
| macOS | Apple Silicon (arm64) | `Gezel-<version>-arm64.pkg` | Application and PKG are Developer ID signed, notarized, and stapled |
| Linux | x64, arm64 | `Gezel-<version>-<arch>.deb` and `.rpm` | Packages are currently unsigned; repository signing is distribution-specific |
| Supply chain | all | `gezel.cdx.json` | CycloneDX production SBOM retained with the release artifacts |

There are six installers: one Windows EXE, one macOS PKG, and DEB/RPM packages for each Linux architecture. Gezel does not currently release a DMG, AppImage, Intel Mac build, Windows Arm build, Flatpak, or Snap.

The Windows NSIS target produces `electron-updater` metadata. The PKG-only macOS target does not produce `latest-mac.yml`, and DEB/RPM builds do not produce `latest-linux.yml`; those platforms need an installer or package-repository update channel rather than GitHub updater metadata.

The installers register `gezeld` as a machine service:

- Windows: `GezelService` hosted by the first-party `gezel-service-host` helper under a restricted LocalService/service-SID identity.
- macOS: `com.bendyline.gezeld` as a LaunchDaemon using the `_gezeld` account.
- Linux: `gezeld.service` under the dedicated `gezel` account, managed by systemd.

## Required setup

Configure these repository secrets under **Settings → Secrets and variables → Actions**. Preflight rejects an empty value.

### Windows: Azure Trusted Signing

| Secret | Purpose |
| --- | --- |
| `AZURE_CODE_SIGNING_ENDPOINT` | Trusted Signing account endpoint, such as `https://wus2.codesigning.azure.net/` |
| `AZURE_CODE_SIGNING_ACCOUNT` | Trusted Signing account name |
| `AZURE_CERT_PROFILE_NAME` | Certificate profile name |
| `AZURE_TENANT_ID` | Microsoft Entra tenant for the signing service principal |
| `AZURE_CLIENT_ID` | Service-principal client ID with the Trusted Signing Certificate Profile Signer role |
| `AZURE_CLIENT_SECRET` | Service-principal client secret |

The job installs the pinned Microsoft Trusted Signing client, signs through [`packages/app/scripts/sign.cjs`](packages/app/scripts/sign.cjs), and verifies both the installer and unpacked `gezel.exe` with `Get-AuthenticodeSignature`.

### macOS: Developer ID and notarization

| Secret | Purpose |
| --- | --- |
| `APPLE_CERTIFICATE_P12_BASE64` | Base64-encoded password-protected `.p12` containing the required Developer ID signing identities |
| `APPLE_CERTIFICATE_PASSWORD` | Password used to export the `.p12` |
| `APPLE_ID` | Apple Developer account email |
| `APPLE_ID_PASSWORD` | App-specific password, not the Apple account password |
| `APPLE_TEAM_ID` | Ten-character Apple Developer team ID |

The job imports the certificate into a temporary keychain. Electron Builder signs and notarizes the application and PKG; CI then verifies the PKG signature, Gatekeeper assessment, and stapled notarization ticket. The temporary keychain is deleted even if packaging fails.

### Optional release token

`GEZEL_RELEASE_TOKEN` is only needed when the draft is created in a repository other than the one running the workflow. Otherwise the workflow uses `github.token`. A mirror requires a fine-grained token with **Contents: write** on that repository and a corresponding workflow `repository:` change.

## Cut the native release first

The Electron workflow does **not** build native engines and does **not** consume a draft. It downloads assets from an already-published `native-vX.Y.Z` release, so that release is a hard prerequisite. Native cadence is deliberately decoupled from app cadence — reuse the current published native release unless an engine pin moved.

When you do need a new one:

1. Optionally rehearse first: **Actions → Build native engines → Run workflow** builds every matrix leg and uploads artifacts but creates no draft. Pull a leg's output locally with `node scripts/fetch-native-binaries.mjs --run <run-id>` to validate before spending a tag.
2. `node scripts/cut-native-release.mjs <version>` validates the version, branch, and tree, then pushes the `native-vX.Y.Z` tag. The tag push is what triggers the matrix plus the `draft_release` job.
3. The draft job gates itself: every platform archive must be present, each archive must contain the engine binaries [`scripts/native-payload.mjs`](scripts/native-payload.mjs) declares for that platform key, and `SHA256SUMS` must verify. Build-provenance attestations are attached at draft time.
4. Validate the draft. `node scripts/fetch-native-binaries.mjs --version <version>` stages it into `packages/app/native-bin/` for local smoke testing.
5. **Publish the draft from the GitHub Releases UI.** Until you do, the Electron workflow's preflight rejects the tag with "still a draft".

A failed leg produces no draft at all, so an absent release usually means a red `Build native engines` run — check that before assuming the tag never fired.

6. **Re-pin the npm side.** `node scripts/pin-native-release.mjs --latest` updates `NATIVE_ENGINE_RELEASE` and `SHA256SUMS_DIGEST` in [`packages/service/src/engines/native-manifest.ts`](packages/service/src/engines/native-manifest.ts). Those two constants are the root of trust for engine downloads by anyone who installed from npm — they have no bundled binaries, so a stale pin sends them at the previous release. Review the diff and commit it; see [docs/npm-release.md](docs/npm-release.md).

## Cut a release

1. Publish a complete native-engine release from the commit you intend to ship, as above. Its tag must be `native-vX.Y.Z` and it must contain every asset checked by the Electron workflow preflight.
2. Confirm all required signing and notarization secrets are configured.
3. Open **Actions → Release Electron App → Run workflow**.
4. Select the source ref and enter the exact published `nativeTag`. There is no “draft” checkbox: draft creation is mandatory.
5. Wait for the workflow to complete. It runs these gates in order:
   - preflight validates credentials, the native tag, and all native release assets;
   - quality builds the workspace, typechecks, lints, runs unit plus browser/Electron E2E tests, generates the SBOM, audits vulnerabilities, and audits licenses;
   - Windows, macOS, and the two-entry Linux architecture matrix stage the same native release, verify the staged engine payload is complete for that host, and build platform artifacts;
   - platform verification checks Windows signatures and macOS signing/notarization;
   - the release job collects every artifact and creates or updates only a draft `v<version>` release.
6. Open the draft release. Confirm the six installers, Windows/macOS update metadata, blockmaps, SBOM, generated notes, tag, and target commit.
7. Complete the smoke-test checklist below.
8. Edit the generated notes if necessary, then click **Publish release** manually.

## Local packaging

Local packages are useful for exercising the build and installer hooks. They do not satisfy the production workflow's signature, notarization, native-release, or quality gates and must not be uploaded as official releases.

```bash
pnpm build:packaged  # workspace + service bundle + legal payload
pnpm package:mac     # PKG, on macOS
pnpm package:win     # NSIS EXE, on Windows
pnpm package:linux   # DEB and RPM, on Linux
```

Outputs land in `packages/app/dist/installers/`. Platform packaging generally needs to run on that platform. A local build without production credentials may be unsigned and may trigger Gatekeeper or SmartScreen; that behavior is allowed only for local validation.

Before diagnosing packaging itself, run the same inexpensive policy gates CI uses:

```bash
pnpm check:notice
pnpm audit:licenses
pnpm audit:sbom
```

## Draft smoke-test checklist

Do not publish until every applicable item passes.

- [ ] Check the release tag and target commit, and confirm the native tag recorded in the workflow run is the intended published native release.
- [ ] Confirm all six installers, the Windows blockmap and `latest.yml`, and `gezel.cdx.json` are present. Confirm there is no unexpected DMG, AppImage, `latest-mac.yml`, or `latest-linux.yml`.
- [ ] Inspect an installed build's `resources/licenses/` directory and run the packaged-license verifier documented by the workflow; confirm `NOTICE.md`, native license texts, font license texts, and the generated dependency-license manifest are present.
- [ ] On a clean x64 Windows 10/11 VM, install the EXE and confirm the publisher signature is valid, the app launches, and `GezelService` runs under the intended restricted identity.
- [ ] On a clean Apple Silicon Mac, install the PKG and confirm:
  - `spctl --assess --type install <pkg>` accepts the installer;
  - `/Applications/Gezel.app` launches without a Gatekeeper warning;
  - `launchctl print system/com.bendyline.gezeld` reports a running service;
  - `/Library/Application Support/Gezel/runtime/port` contains the loopback port;
  - the service starts after reboot before an interactive login.
- [ ] On clean x64 and arm64 Debian/Ubuntu systems, install the matching DEB with `apt`, then confirm `systemctl status gezeld`, `/var/lib/gezel/runtime/port`, the `gezel` service account, post-reboot startup, and desktop connection without embedded fallback.
- [ ] On clean x64 and arm64 Fedora-compatible systems, repeat the service and desktop checks with the matching RPM installed through `dnf`.
- [ ] Install the previous Windows release, publish the new release in a controlled test window, and confirm the in-app updater discovers the new version. Verify macOS installer-update and Linux package-manager upgrade behavior through their eventual distribution channels separately.

If a gate or smoke test fails, leave the release in draft, fix the source or workflow, and dispatch a new run. Do not work around production signing or artifact-verification failures by publishing local unsigned files.
