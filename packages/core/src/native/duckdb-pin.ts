/**
 * Pinned DuckDB CLI release, and the one place its identity lives.
 *
 * DuckDB is **vendored, not built**. The DuckDB Foundation publishes a
 * precompiled single-file CLI per platform, already Developer ID signed and
 * notarized on macOS and Authenticode signed on Windows, so Gezel
 * redistributes those exact bytes rather than compiling or re-signing them.
 * That is the same provenance rule the bundled Node runtime follows (see the
 * `signIgnore` block in `packages/app/electron-builder.yml`): when a vendor
 * already ships a binary that satisfies the platform's own trust model,
 * putting our signature on it replaces their attestation with ours and
 * destroys the "hash-comparable against the vendor's manifest" property.
 *
 * Two consumers read this module, which is why it lives in core rather than
 * in `packages/app`:
 *
 *   - `packages/app/scripts/fetch-duckdb.mjs` stages the binary into the
 *     Electron installer at build time.
 *   - `packages/service/src/engines/resolver.ts` downloads it at runtime for
 *     npm / CLI installs that have no Electron payload.
 *
 * Both verify against {@link DUCKDB_ARCHIVE_SHA256} (the published archive)
 * and {@link DUCKDB_BINARY_SHA256} (the executable inside it), and both land
 * the result in the same versioned directory — see {@link duckdbInstallDir} —
 * so a machine with both a desktop install and an npm `gezeld` shares one
 * verified copy.
 *
 * ── Why two digests ──────────────────────────────────────────────────────
 *
 * The archive digest is what the download path can check before it unpacks
 * anything, and it is the value comparable against a digest a user computes
 * from DuckDB's own release page. The binary digest is what the *bundle*
 * path checks, because the Electron installer ships the extracted executable
 * with no archive around it. Recording only one would leave one of the two
 * paths verifying nothing.
 *
 * ── Bumping ──────────────────────────────────────────────────────────────
 *
 * Run `node scripts/bump-duckdb.mjs <version>`. It downloads every platform
 * archive, computes both digests, confirms the CLI reports the pinned commit,
 * and rewrites this file. The PR diff is the audit trail. Never hand-edit a
 * digest.
 *
 * A version bump is a security review, not a chore: `DuckRunner`'s
 * configuration prelude and `statement-guard`'s use of `json_serialize_sql`
 * are behavioural contracts measured against a specific engine build. Re-run
 * the sandbox matrix in `docs/observation-corpora.md` before landing one.
 *
 * License: MIT — https://github.com/duckdb/duckdb
 */

import { join } from 'node:path';

/** Upstream release tag, without the leading `v`. */
export const DUCKDB_VERSION = '1.5.5';

/**
 * The commit the tag points at. `duckdb --version` echoes its first ten
 * characters, which is how the fetch and bump scripts prove they unpacked the
 * build this file claims rather than whatever the URL happened to serve.
 */
export const DUCKDB_COMMIT = 'd8cdaa33fda8df955cc76ef58a280f68f4cd43fa';

/**
 * sha256 of DuckDB's `LICENSE` at {@link DUCKDB_COMMIT}. Pinned for the same
 * reason the binary is: we redistribute the text, so a silent upstream change
 * to the terms should fail the build rather than ship unnoticed.
 */
export const DUCKDB_LICENSE_SHA256 =
  '7e17fd31249fa875cb3b1c5e05c6c3e99b75509f6a2804ca176c217834de1dcb';

/** Platform keys this pin covers — the platforms Gezel ships a daemon for. */
export type DuckdbPlatformKey = 'darwin-arm64' | 'linux-x64' | 'linux-arm64' | 'win32-x64';

/**
 * Release asset per platform. The glibc archives are pinned over the `-musl`
 * variants to match the rest of the native tree.
 */
export const DUCKDB_ASSET: Record<DuckdbPlatformKey, string> = {
  'darwin-arm64': 'duckdb_cli-osx-arm64.zip',
  'linux-x64': 'duckdb_cli-linux-amd64.zip',
  'linux-arm64': 'duckdb_cli-linux-arm64.zip',
  'win32-x64': 'duckdb_cli-windows-amd64.zip',
};

/** sha256 of each published archive, as served by duckdb/duckdb's releases. */
export const DUCKDB_ARCHIVE_SHA256: Record<DuckdbPlatformKey, string> = {
  'darwin-arm64': 'da5177b8869c4ed8c65d514fb47a8ed0f6fa7427f103304932d5e83851e46abd',
  'linux-x64': '08c0ca117111fcede14239d0093792352befdc174218c344d232c13279643d05',
  'linux-arm64': '02163197027a42149147364d31fa67cac82108517a4be43304a1cc226eaef07a',
  'win32-x64': 'e1428b7114a841626b5054723731cbf45c6df91b42ae1a6c355f88fad1f6dc4c',
};

/** sha256 of the `duckdb[.exe]` executable inside each archive. */
export const DUCKDB_BINARY_SHA256: Record<DuckdbPlatformKey, string> = {
  'darwin-arm64': 'd0610710dd30667aa6c76709299b6822e55dc9199803350aa2e1b06e3346943b',
  'linux-x64': '3d33b1df037cb049155c393778df7853fafb23e9d49d7c9cacdde4dd67155788',
  'linux-arm64': '9882c99a9804407de82c0edb1816d7667733d37d771a98eb23ad5f6a8d37acb1',
  'win32-x64': 'fde737c7749075f6b54e14772a4e6b33a5fa0201075d03640aca358074ea4554',
};

/**
 * The DuckDB Foundation's Apple Developer Team ID. macOS verification asserts
 * *this* identity rather than Bendyline's — the whole point of vendoring the
 * signed binary is that the vendor's attestation is the one that travels with
 * it. Asserting the vendor's team is strictly stronger than the Windows
 * precedent, which today asserts no publisher at all for vendored binaries.
 */
export const DUCKDB_APPLE_TEAM_ID = '7NCTQWA3HA';

/** Authenticode subject common name on the Windows build. */
export const DUCKDB_WINDOWS_PUBLISHER = 'Stichting DuckDB Foundation';

/** Base URL for the pinned release's assets. */
export function duckdbAssetUrl(key: DuckdbPlatformKey, version = DUCKDB_VERSION): string {
  return `https://github.com/duckdb/duckdb/releases/download/v${version}/${DUCKDB_ASSET[key]}`;
}

/**
 * Map `(process.platform, process.arch)` to a pin key, or `null` where DuckDB
 * publishes no build we ship. Callers treat `null` as "no bundled query
 * engine on this host" and fall back to a system install.
 */
export function duckdbPlatformKey(
  platform: NodeJS.Platform,
  arch: string,
): DuckdbPlatformKey | null {
  if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64';
  if (platform === 'linux' && arch === 'x64') return 'linux-x64';
  if (platform === 'linux' && arch === 'arm64') return 'linux-arm64';
  if (platform === 'win32' && arch === 'x64') return 'win32-x64';
  return null;
}

/** Executable name on this platform. */
export function duckdbBinaryName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'duckdb.exe' : 'duckdb';
}

/**
 * Versioned install directory: `<home>/engines/duckdb/<version>/`.
 *
 * Versioned so a pin bump installs alongside the old copy rather than
 * mutating a binary a running query may be executing, and so the discovery
 * ladder can ask for exactly the build whose sandbox behaviour we measured.
 * Shared by the Electron bundle installer and the CLI downloader on purpose:
 * one machine, one verified copy, whichever install path put it there.
 */
export function duckdbInstallDir(home: string, version = DUCKDB_VERSION): string {
  return join(home, 'engines', 'duckdb', version);
}

/** Absolute path to the pinned executable inside {@link duckdbInstallDir}. */
export function duckdbInstalledBinary(
  home: string,
  platform: NodeJS.Platform = process.platform,
  version = DUCKDB_VERSION,
): string {
  return join(duckdbInstallDir(home, version), duckdbBinaryName(platform));
}
