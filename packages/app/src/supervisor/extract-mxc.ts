import { existsSync } from 'node:fs';
import { cp, lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MXC_EXECUTOR_NAME,
  MXC_EXECUTOR_SHA256,
  MXC_VERIFIED_SENTINEL,
  MXC_VERSION,
  type MxcArch,
  type MxcVerifiedSentinel,
  mxcArch,
  mxcInstallDir,
} from '@bendyline/gezel/native';
import { sha256File, verifyBundleManifest } from './bundle-manifest.js';
import { redirectAsarToUnpacked } from './extract-bundle.js';
import { resolveRuntimeInPlace } from './run-in-place.js';

export interface MxcInstallOptions {
  /** User home root — the launcher lands at `<home>/engines/mxc/<version>/`. */
  home: string;
  /** Source directory (electron app's `dist/mxc-bundle/`). */
  bundleDir: string;
  logger?: { info?: (m: string) => void; warn?: (m: string) => void };
}

export interface MxcInstallResult {
  /** Absolute path to the installed launcher, or null when none was installed. */
  executorPath: string | null;
  version: string | null;
  action: 'fresh-install' | 'refreshed' | 'up-to-date' | 'no-bundle';
  /** True only when the shipped manifest authenticated the installed bytes. */
  verified: boolean;
}

/**
 * Resolve the MXC bundle's source directory. Dev: `packages/app/dist/mxc-bundle/`.
 * Packaged: `app.asar.unpacked/dist/mxc-bundle/`.
 */
export function defaultMxcBundleDir(mainMetaUrl: string): string {
  const mainDir = dirname(fileURLToPath(mainMetaUrl));
  return redirectAsarToUnpacked(resolve(mainDir, 'mxc-bundle'));
}

/** The pinned arch whose digest these bytes match, if any. */
function pinnedArchFor(digest: string): MxcArch | null {
  for (const [arch, sha] of Object.entries(MXC_EXECUTOR_SHA256) as [MxcArch, string][]) {
    if (sha === digest) return arch;
  }
  return null;
}

/**
 * Install the bundled MXC launcher into the version-keyed directory the
 * service's engine resolver also downloads into, and write the sentinel that
 * resolver and `readVerifiedMxcExecutor` read, so either installer's work
 * satisfies the other.
 *
 * Stricter than the DuckDB installer in one way: when the bundle claims this
 * build's pinned version, its bytes must also equal a pinned launcher digest
 * compiled into this build, not just the bundle's own `sha256.txt`. This file
 * is the containment boundary for sandboxed scripts, so the manifest that
 * shipped beside it is not allowed to be the only witness.
 *
 * A missing bundle is not fatal (`no-bundle`): sandboxed scripts then run
 * without MXC containment, which the sandbox status reports.
 */
export async function installMxcIfNeeded(opts: MxcInstallOptions): Promise<MxcInstallResult> {
  const { home, bundleDir, logger } = opts;
  const none: MxcInstallResult = {
    executorPath: null,
    version: null,
    action: 'no-bundle',
    verified: false,
  };

  const bundleExecutor = join(bundleDir, MXC_EXECUTOR_NAME);
  const versionFilePath = join(bundleDir, 'version.txt');
  if (!existsSync(bundleExecutor) || !existsSync(versionFilePath)) {
    logger?.info?.(`[supervisor] no mxc bundle at ${bundleDir}`);
    return none;
  }

  const shippedVersion = (await readFile(versionFilePath, 'utf8')).trim();
  const integrity = await verifyBundleManifest(bundleDir, [MXC_EXECUTOR_NAME]);
  if (!integrity.ok) {
    logger?.warn?.(
      `[supervisor] mxc bundle failed integrity check (${integrity.reason}); refusing to install`,
    );
    return none;
  }

  const bundleDigest = await sha256File(bundleExecutor);
  const pinnedArch = pinnedArchFor(bundleDigest);
  if (shippedVersion === MXC_VERSION && !pinnedArch) {
    logger?.warn?.(
      `[supervisor] mxc bundle v${shippedVersion} is not a pinned launcher (${bundleDigest}); refusing to install`,
    );
    return none;
  }
  const arch = pinnedArch ?? mxcArch();
  if (!arch) {
    logger?.warn?.('[supervisor] mxc bundle present on a machine MXC ships no launcher for');
    return none;
  }

  const installDir = mxcInstallDir(home, shippedVersion);
  const installedExecutor = join(installDir, MXC_EXECUTOR_NAME);
  const sentinelPath = join(installDir, MXC_VERIFIED_SENTINEL);
  // The compiled-in pin is a stronger witness than the shipped manifest, so
  // matching it counts as verified even for a bundle with no sha256.txt.
  const verified = pinnedArch !== null || !integrity.skipped;

  const hadPrevious = existsSync(installedExecutor);
  if (hadPrevious) {
    const installedFile = await lstat(installedExecutor);
    const installedDigest = installedFile.isFile() ? await sha256File(installedExecutor) : null;
    if (installedDigest === bundleDigest) {
      if ((await readSentinelDigest(sentinelPath)) !== bundleDigest) {
        await writeSentinel(sentinelPath, shippedVersion, arch, bundleDigest);
      }
      return {
        executorPath: installedExecutor,
        version: shippedVersion,
        action: 'up-to-date',
        verified,
      };
    }
    logger?.warn?.(
      `[supervisor] installed mxc launcher v${shippedVersion} failed byte verification; refreshing it from the shipped bundle`,
    );
  }

  await mkdir(installDir, { recursive: true });
  logger?.info?.(
    hadPrevious
      ? `[supervisor] refreshing bundled mxc launcher v${shippedVersion}`
      : `[supervisor] installing bundled mxc launcher v${shippedVersion}`,
  );

  // A sentinel that outlives the bytes it vouched for would let the lookup
  // trust whatever lands next, so it goes before the launcher is touched.
  await rm(sentinelPath, { force: true });
  const stagingExecutor = `${installedExecutor}.staging-${process.pid}-${Date.now()}`;
  await rm(stagingExecutor, { force: true });
  await cp(bundleExecutor, stagingExecutor, { force: true });

  const staged = await stat(stagingExecutor);
  const stagedDigest = staged.isFile() ? await sha256File(stagingExecutor) : null;
  if (!staged.isFile() || stagedDigest !== bundleDigest) {
    await rm(stagingExecutor, { force: true });
    throw new Error(
      `[supervisor] staged-copy verify failed: ${stagingExecutor} is missing or its bytes differ from the authenticated bundle`,
    );
  }
  await rm(installedExecutor, { recursive: true, force: true });
  await rename(stagingExecutor, installedExecutor);

  const installedDigest = await sha256File(installedExecutor);
  if (installedDigest !== bundleDigest) {
    await rm(installedExecutor, { force: true });
    throw new Error(
      `[supervisor] post-install verify failed: ${installedExecutor} differs from the authenticated bundle`,
    );
  }
  await writeSentinel(sentinelPath, shippedVersion, arch, bundleDigest);

  return {
    executorPath: installedExecutor,
    version: shippedVersion,
    action: hadPrevious ? 'refreshed' : 'fresh-install',
    verified,
  };
}

export const MXC_EXEC_ENV = 'GEZEL_MXC_EXEC';

export interface ProvisionMxcOptions extends MxcInstallOptions {
  packaged: boolean;
  /** The store lane that must not copy executables out of the bundle. */
  runInPlace: boolean;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

/**
 * Point {@link MXC_EXEC_ENV} at the bundled launcher, on Windows only.
 *
 * Packaged launches drop any inherited value first and set only a verified
 * path — the Node runtime's rule, not DuckDB's "only if unset". The variable
 * picks the containment boundary for every sandboxed script, so an
 * environment the app merely inherited must not be able to choose it.
 * Development keeps an operator-set value, which is how the launcher is
 * pointed at a local MXC build.
 *
 * Never throws: without a launcher, sandboxed scripts run uncontained and the
 * sandbox status says so.
 */
export async function provisionMxcExecutor(opts: ProvisionMxcOptions): Promise<void> {
  const env = opts.env ?? process.env;
  if ((opts.platform ?? process.platform) !== 'win32') return;
  if (opts.packaged) {
    delete env[MXC_EXEC_ENV];
  } else if (env[MXC_EXEC_ENV]) {
    opts.logger?.info?.(`[supervisor] keeping operator-set ${MXC_EXEC_ENV}=${env[MXC_EXEC_ENV]}`);
    return;
  }
  try {
    if (opts.runInPlace) {
      const inPlace = await resolveRuntimeInPlace({
        bundleDir: opts.bundleDir,
        entry: MXC_EXECUTOR_NAME,
        ...(opts.logger ? { logger: opts.logger } : {}),
      });
      if (inPlace.path && inPlace.verified) {
        env[MXC_EXEC_ENV] = inPlace.path;
      } else {
        opts.logger?.warn?.(
          `[supervisor] bundled mxc launcher unavailable in place (${inPlace.reason ?? 'unverified'}); sandboxed scripts run without containment`,
        );
      }
      return;
    }
    const installed = await installMxcIfNeeded(opts);
    if (installed.executorPath && (installed.verified || !opts.packaged)) {
      env[MXC_EXEC_ENV] = installed.executorPath;
      opts.logger?.info?.(
        `[supervisor] bundled mxc launcher v${installed.version} (${installed.action}): ${installed.executorPath}`,
      );
    } else if (installed.executorPath) {
      opts.logger?.warn?.(
        '[supervisor] bundled mxc launcher is unverified; sandboxed scripts run without containment',
      );
    }
  } catch (err) {
    opts.logger?.warn?.(`[supervisor] mxc launcher install failed: ${String(err)}`);
  }
}

async function readSentinelDigest(sentinelPath: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(sentinelPath, 'utf8')) as { sha256?: unknown };
    return typeof parsed.sha256 === 'string' ? parsed.sha256.toLowerCase() : null;
  } catch {
    return null;
  }
}

async function writeSentinel(
  sentinelPath: string,
  version: string,
  arch: MxcArch,
  sha256: string,
): Promise<void> {
  const sentinel: MxcVerifiedSentinel = {
    engine: 'mxc',
    version,
    arch,
    sha256,
    source: 'electron-bundle',
    verifiedAt: new Date().toISOString(),
  };
  await writeFile(sentinelPath, `${JSON.stringify(sentinel, null, 2)}\n`, 'utf8');
}
