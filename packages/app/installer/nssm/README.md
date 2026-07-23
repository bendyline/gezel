# NSSM

This directory holds `nssm.exe`, the [Non-Sucking Service Manager](https://nssm.cc/),
which the Windows installer uses to register `gezeld` as a Windows
Service (see [nsis-hooks.nsh](../nsis-hooks.nsh) and the `win.extraFiles`
entry in [electron-builder.yml](../../electron-builder.yml)). macOS and
Linux installers don't use it — `extraFiles` is gated on the `win:`
platform.

## The binary is checked in — deliberately

`nssm.exe` (NSSM 2.24, win64) is vendored in this repo rather than
downloaded at package time. NSSM is public domain, 2.24 has been the
stable release for a decade, and nssm.cc is a single slow server — a
release-time download puts an availability and supply-chain dependency
on the critical path for no benefit. Vendoring the reviewed bytes and
pinning their hash means every build ships exactly the binary that was
audited, even if the upstream site is down or serving something else.

Provenance, verified against the official distribution:

| Artifact | sha256 |
|---|---|
| `nssm-2.24.zip` (official, `https://nssm.cc/release/nssm-2.24.zip`) | `727d1e42275c605e0f04aba98095c38a8e1e46def453cdffce42869428aa6743` |
| `nssm-2.24/win64/nssm.exe` (this file) | `f689ee9af94b00e9e3f0bb072b34caaf207f32dcb4f5782fc9ca351df9a06c97` |

Verify locally:

```sh
shasum -a 256 packages/app/installer/nssm/nssm.exe
```

Three guards keep the committed binary honest:

- [`fetch-nssm.mjs`](../../scripts/fetch-nssm.mjs) (tsup `onSuccess`,
  Windows builds) verifies the sha and only reaches for the network if
  the file is missing or corrupt.
- The Windows release job in
  [release-electron.yml](../../../../.github/workflows/release-electron.yml)
  re-verifies the same sha before packaging and fails the release on a
  mismatch — no download.
- [`nssm-binary.test.ts`](../../src/nssm-binary.test.ts) asserts that the
  committed bytes, the fetch-script pin, and this README all agree, so a
  swapped binary fails `pnpm test`.

## Bumping NSSM

If upstream ever cuts a new stable release: download the official zip,
extract `win64/nssm.exe`, replace this file, and update the sha256 in
[`fetch-nssm.mjs`](../../scripts/fetch-nssm.mjs), this README (both
hashes), and [NOTICE.md](../../../../NOTICE.md) in the same commit — the
unit test enforces the agreement. Building from the public source
(`https://git.nssm.cc/nssm/nssm`, MSVC) is a reasonable alternative if
the release site ever disappears.

License: NSSM is public domain (per the upstream readme); attribution
lives in [NOTICE.md](../../../../NOTICE.md).
