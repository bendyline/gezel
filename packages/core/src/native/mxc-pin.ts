/**
 * Pinned Microsoft eXecution Containers (MXC) launcher, and the one place its
 * identity lives.
 *
 * `wxc-exec.exe` is Microsoft's standalone MXC launcher: it starts a process
 * inside a Windows process container from a JSON policy. Gezel uses it as the
 * containment boundary for sandboxed scripts on Windows. It needs no other
 * file from its package, so Gezel ships that one executable and nothing else.
 *
 * Like DuckDB (see `duckdb-pin.ts`) it is **vendored, not built**. Microsoft
 * publishes it Authenticode-signed inside the `@microsoft/mxc-sdk` npm
 * package, and Gezel redistributes those exact bytes. Re-signing would replace
 * Microsoft's attestation with ours and break the "hash-comparable against the
 * vendor's package" property, so every consumer asserts
 * {@link MXC_WINDOWS_PUBLISHER} instead of Bendyline.
 *
 * Consumers:
 *
 *   - `packages/app/scripts/fetch-mxc.mjs` stages the launcher into the
 *     Windows Electron installer at build time. It regex-parses this file, so
 *     keep every pinned value a single-quoted literal.
 *   - `packages/app/src/supervisor/extract-mxc.ts` installs that bundle into
 *     {@link mxcInstallDir} on first launch.
 *   - `packages/inference/src/engines/resolver.ts` (`resolveVendoredMxc`)
 *     downloads the same tarball for npm / CLI installs into the same
 *     directory, so a machine with both shares one verified copy.
 *   - `scripts/bump-mxc.mjs`, `scripts/check-notice.mjs` and
 *     `scripts/sbom-enrichment.mjs` read the literals below.
 *
 * ── Why three digests ────────────────────────────────────────────────────
 *
 * {@link MXC_TARBALL_INTEGRITY} is npm's own `dist.integrity`, comparable with
 * `npm view @microsoft/mxc-sdk@<v> dist.integrity`. {@link MXC_TARBALL_SHA256}
 * is the same tarball as SHA-256, which is what the SBOM and the other runtime
 * pins record. {@link MXC_EXECUTOR_SHA256} is what the installer path checks,
 * because the Electron bundle ships the extracted executable with no tarball
 * around it.
 *
 * ── Bumping ──────────────────────────────────────────────────────────────
 *
 * Run `node scripts/bump-mxc.mjs <version>`. Never hand-edit a digest. A bump
 * changes the containment boundary every sandboxed script runs inside, so
 * re-run the MXC sandbox integration suite before landing one.
 *
 * License: MIT — https://github.com/microsoft/mxc
 */

import { existsSync, readFileSync } from 'node:fs';
import { machine } from 'node:os';
import { join } from 'node:path';

/** Upstream npm package version. */
export const MXC_VERSION = '1.0.0';

/** The npm package the launcher is taken from. */
export const MXC_NPM_PACKAGE = '@microsoft/mxc-sdk';

/** Registry tarball for {@link MXC_VERSION}. */
export const MXC_TARBALL_URL = 'https://registry.npmjs.org/@microsoft/mxc-sdk/-/mxc-sdk-1.0.0.tgz';

/** npm's `dist.integrity` for {@link MXC_TARBALL_URL}. */
export const MXC_TARBALL_INTEGRITY =
  'sha512-7aVR+GHVKveIknZmUtkAEFwUBp61qgEmhJRe1ZyKHJ274yWlKWB/ZfDP/u/whfmDyck0wRNKZN49atlF+SZt2Q==';

/** sha256 of the same tarball. */
export const MXC_TARBALL_SHA256 =
  '39e59ffd9d0832334889b0cd583d0beb43b1bbbe9f783dd7c6980203d23e9602';

/**
 * sha256 of `package/LICENSE.md`. Pinned because we redistribute the text: a
 * silent upstream change to the terms should fail the build.
 */
export const MXC_LICENSE_SHA256 =
  'd9a1b1e30d633d5732ea18e3cba9538d293ebc53e1a9e4e96ab739e0c5c4f1cb';

/** Windows architectures the package ships a launcher for. */
export type MxcArch = 'x64' | 'arm64';

/** sha256 of `package/bin/<arch>/wxc-exec.exe`. */
export const MXC_EXECUTOR_SHA256: Record<MxcArch, string> = {
  x64: '8a6d1db4dd1846981127d9014741be18b094d07be967765dff6754bda1d40259',
  arm64: 'a1dc1218e26dfae2e463ebede99591ab9b4adcc4efe5d09cc3302b053997244e',
};

/** Authenticode subject on both launchers. */
export const MXC_WINDOWS_PUBLISHER = 'Microsoft Corporation';

/** Launcher file name, inside the package and on disk. */
export const MXC_EXECUTOR_NAME = 'wxc-exec.exe';

/**
 * Sentinel written beside a verified install, in the same place and shape
 * family as DuckDB's. It records which arch's digest the bytes matched, so a
 * pin bump invalidates it without comparing version strings alone.
 */
export const MXC_VERIFIED_SENTINEL = '.verified.json';

/** Path of the launcher inside the npm tarball. */
export function mxcTarballEntry(arch: MxcArch): string {
  return `package/bin/${arch}/${MXC_EXECUTOR_NAME}`;
}

/** Path of the license inside the npm tarball. */
export const MXC_TARBALL_LICENSE_ENTRY = 'package/LICENSE.md';

/**
 * Map an `os.machine()` value to the launcher arch, or `null` where MXC ships
 * none.
 *
 * Reads the machine type rather than `process.arch` so the choice follows the
 * OS where the two can differ. Under Windows' x64 emulation on ARM64, Windows
 * itself reports x64 to the emulated process, so such a process gets the x64
 * launcher — which runs under the same emulation.
 */
export function mxcArch(machineType: string = machine()): MxcArch | null {
  switch (machineType.toLowerCase()) {
    case 'x86_64':
    case 'amd64':
    case 'x64':
      return 'x64';
    case 'arm64':
    case 'aarch64':
      return 'arm64';
    default:
      return null;
  }
}

/**
 * Versioned install directory: `<home>/engines/mxc/<version>/`. Shared by the
 * Electron bundle installer and the CLI downloader.
 */
export function mxcInstallDir(home: string, version = MXC_VERSION): string {
  return join(home, 'engines', 'mxc', version);
}

/** Absolute path to the launcher inside {@link mxcInstallDir}. */
export function mxcInstalledExecutor(home: string, version = MXC_VERSION): string {
  return join(mxcInstallDir(home, version), MXC_EXECUTOR_NAME);
}

/** The fields every writer of {@link MXC_VERIFIED_SENTINEL} records. */
export interface MxcVerifiedSentinel {
  engine: 'mxc';
  version: string;
  arch: MxcArch;
  sha256: string;
  source: 'electron-bundle' | 'npm-download';
  verifiedAt: string;
}

/**
 * The pinned launcher's path when a verified install for this build's pin and
 * this machine's arch is on disk, else `null`.
 *
 * Cheap and synchronous: it trusts the sentinel instead of re-hashing, which
 * is the same trade every installed-engine lookup makes. The writers only
 * produce the sentinel after hashing the bytes they published.
 */
export function readVerifiedMxcExecutor(
  home: string,
  arch: MxcArch | null = mxcArch(),
): string | null {
  if (!arch) return null;
  const executor = mxcInstalledExecutor(home);
  const sentinelPath = join(mxcInstallDir(home), MXC_VERIFIED_SENTINEL);
  if (!existsSync(executor) || !existsSync(sentinelPath)) return null;
  let sentinel: Partial<MxcVerifiedSentinel>;
  try {
    sentinel = JSON.parse(readFileSync(sentinelPath, 'utf8')) as Partial<MxcVerifiedSentinel>;
  } catch {
    return null;
  }
  if (sentinel.version !== MXC_VERSION) return null;
  if (sentinel.sha256?.toLowerCase() !== MXC_EXECUTOR_SHA256[arch]) return null;
  return executor;
}
