import { existsSync } from 'node:fs';
import { chmod, cp, lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DUCKDB_ARCHIVE_SHA256,
  DUCKDB_VERSION,
  duckdbBinaryName,
  duckdbInstallDir,
  duckdbPlatformKey,
} from '@bendyline/gezel/native';
import { sha256File, verifyBundleManifest } from './bundle-manifest.js';
import { redirectAsarToUnpacked } from './extract-bundle.js';

export interface DuckdbInstallOptions {
  /** User home root — binary lands at `<home>/engines/duckdb/<version>/`. */
  home: string;
  /** Source directory (electron app's `dist/duckdb-bundle/`). */
  bundleDir: string;
  logger?: { info?: (m: string) => void; warn?: (m: string) => void };
}

export interface DuckdbInstallResult {
  /** Absolute path to the installed binary, or null when no bundle shipped. */
  binaryPath: string | null;
  version: string | null;
  action: 'fresh-install' | 'upgraded' | 'refreshed' | 'up-to-date' | 'no-bundle';
  /** True only when the shipped manifest authenticated the installed bytes. */
  verified: boolean;
}

/**
 * Resolve the DuckDB bundle's source directory. Dev:
 * `packages/app/dist/duckdb-bundle/`. Packaged:
 * `app.asar.unpacked/dist/duckdb-bundle/`. Mirrors `defaultNodeBundleDir`.
 */
export function defaultDuckdbBundleDir(mainMetaUrl: string): string {
  const mainDir = dirname(fileURLToPath(mainMetaUrl));
  return redirectAsarToUnpacked(resolve(mainDir, 'duckdb-bundle'));
}

/**
 * Install the bundled DuckDB CLI into the **version-keyed** directory that
 * the service's engine resolver also writes to.
 *
 * Sharing that directory is the point, not an accident: a machine running
 * both the desktop app and an npm `gezeld` ends up with one verified copy
 * rather than two, and either installer's work satisfies the other. To make
 * that mutual, this writes the same `.verified.json` sentinel the resolver
 * writes, so the CLI's warm-cache check recognises a desktop-installed copy
 * and does not re-download it.
 *
 * DuckDB is vendored unmodified — these are the DuckDB Foundation's own
 * signed, notarized bytes — so nothing here re-signs anything. The integrity
 * chain is: pinned digest in core → verified download at build time →
 * `sha256.txt` in the bundle → re-hash here → re-hash after the copy.
 *
 * A missing bundle is not fatal (`no-bundle`): DuckDB powers the data
 * features, and a daemon without it degrades to "query engine unavailable"
 * rather than failing to boot.
 */
export async function installDuckdbIfNeeded(
  opts: DuckdbInstallOptions,
): Promise<DuckdbInstallResult> {
  const { home, bundleDir, logger } = opts;

  if (!existsSync(bundleDir)) {
    logger?.info?.(`[supervisor] no duckdb bundle at ${bundleDir}`);
    return { binaryPath: null, version: null, action: 'no-bundle', verified: false };
  }

  const binaryName = duckdbBinaryName(process.platform);
  const bundleBinary = join(bundleDir, binaryName);
  const versionFilePath = join(bundleDir, 'version.txt');

  if (!existsSync(bundleBinary) || !existsSync(versionFilePath)) {
    logger?.info?.('[supervisor] duckdb bundle dir exists but no binary inside (placeholder)');
    return { binaryPath: null, version: null, action: 'no-bundle', verified: false };
  }

  const shippedVersion = (await readFile(versionFilePath, 'utf8')).trim();
  const installDir = duckdbInstallDir(home, shippedVersion);
  const installedBinary = join(installDir, binaryName);
  const sentinelPath = join(installDir, '.verified.json');

  const integrity = await verifyBundleManifest(bundleDir, [binaryName]);
  if (!integrity.ok) {
    logger?.warn?.(
      `[supervisor] duckdb bundle failed integrity check (${integrity.reason}); refusing to install`,
    );
    return { binaryPath: null, version: null, action: 'no-bundle', verified: false };
  }

  const bundleDigest = await sha256File(bundleBinary);
  const hadPrevious = existsSync(installedBinary);
  if (hadPrevious) {
    const installedFile = await lstat(installedBinary);
    const installedDigest = installedFile.isFile() ? await sha256File(installedBinary) : null;
    if (installedDigest === bundleDigest) {
      // Still (re)write the sentinel if it is missing — an older build, or a
      // partially-cleaned home, would otherwise make the CLI re-download a
      // binary that is already here and already correct.
      if (!existsSync(sentinelPath)) {
        await writeSentinel(sentinelPath, shippedVersion, bundleDigest);
      }
      return {
        binaryPath: installedBinary,
        version: shippedVersion,
        action: 'up-to-date',
        verified: !integrity.skipped,
      };
    }
    logger?.warn?.(
      `[supervisor] installed duckdb v${shippedVersion} failed byte verification; refreshing it from the shipped bundle`,
    );
  }

  await mkdir(installDir, { recursive: true });
  logger?.info?.(
    hadPrevious
      ? `[supervisor] refreshing bundled duckdb v${shippedVersion}`
      : `[supervisor] installing bundled duckdb v${shippedVersion}`,
  );

  const stagingBinary = `${installedBinary}.staging-${process.pid}-${Date.now()}`;
  await rm(stagingBinary, { force: true });
  await cp(bundleBinary, stagingBinary, { force: true });
  if (process.platform !== 'win32') {
    try {
      await chmod(stagingBinary, 0o755);
    } catch {
      /* best-effort */
    }
  }

  const staged = await stat(stagingBinary);
  const stagedDigest = staged.isFile() ? await sha256File(stagingBinary) : null;
  if (!staged.isFile() || stagedDigest !== bundleDigest) {
    await rm(stagingBinary, { force: true });
    throw new Error(
      `[supervisor] staged-copy verify failed: ${stagingBinary} is missing or its bytes differ from the authenticated bundle`,
    );
  }
  await rm(installedBinary, { recursive: true, force: true });
  await rename(stagingBinary, installedBinary);

  const installedDigest = await sha256File(installedBinary);
  if (installedDigest !== bundleDigest) {
    await rm(installedBinary, { force: true });
    await rm(sentinelPath, { force: true });
    throw new Error(
      `[supervisor] post-install verify failed: ${installedBinary} differs from the authenticated bundle`,
    );
  }
  await writeSentinel(sentinelPath, shippedVersion, bundleDigest);

  return {
    binaryPath: installedBinary,
    version: shippedVersion,
    action: hadPrevious ? 'refreshed' : 'fresh-install',
    verified: !integrity.skipped,
  };
}

/**
 * Write the sentinel in the shape the service's engine resolver reads, so a
 * desktop-installed copy satisfies the CLI's warm-cache check.
 *
 * `archiveSha` is what that check compares, and it must be the *archive*
 * digest for the pinned version — the bundle ships only the extracted binary,
 * so the value comes from the compiled-in pin rather than from anything on
 * disk. When the bundle's version does not match this build's pin (a bundle
 * staged by a different release), the field is omitted rather than guessed:
 * the CLI then re-verifies by downloading, which is the safe direction.
 */
async function writeSentinel(
  sentinelPath: string,
  version: string,
  binarySha: string,
): Promise<void> {
  const key = duckdbPlatformKey(process.platform, process.arch);
  const archiveSha = version === DUCKDB_VERSION && key ? DUCKDB_ARCHIVE_SHA256[key] : undefined;
  await writeFile(
    sentinelPath,
    `${JSON.stringify(
      {
        engine: 'duckdb',
        version,
        ...(archiveSha ? { archiveSha } : {}),
        binarySha,
        source: 'electron-bundle',
        verifiedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}
