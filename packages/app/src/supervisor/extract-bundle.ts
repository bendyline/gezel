import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as tar from 'tar';

/**
 * Sentinel filename — sha256 of the tarball that produced the install.
 * Lives at `<installDir>/.gezel-bundle.sha256`. Used by
 * `extractBundleIfNeeded` to detect content drift even when versions
 * match (e.g. unreleased v0.0.0 builds during development, or hotfix
 * rebuilds with the same `package.json` version).
 */
const SHA_SENTINEL = '.gezel-bundle.sha256';

/**
 * The service bundle ships as a single gzipped tarball plus a small JSON
 * sidecar with `{ version, sha256, sizeBytes, fileCount }`. Both are
 * asar-unpacked so the supervisor (and the install-time CLI in
 * extract-service-bundle.ts) can read them as real files.
 *
 * Why a tarball instead of a loose tree of ~100k files:
 *   - NSIS extracts 1 file in ~seconds instead of ~30 minutes (the
 *     bottleneck on Windows was Defender real-time-scanning every node_modules
 *     file as it landed during NSIS' extraction phase).
 *   - electron-builder's `asarUnpack` glob walks fewer entries at pack time.
 *   - The .deb/.rpm/.pkg payloads benefit too — fewer inodes to install.
 *
 * The trade-off is a one-time extraction either at install time (system
 * service) or on first user launch (per-user spawn / embedded): about 20s in
 * a warm-cache Windows benchmark, but potentially several minutes under a
 * cold Defender scan. The startup splash makes that work explicit.
 */
export interface BundleMeta {
  version: string;
  sha256: string;
  sizeBytes: number;
  fileCount: number;
}

export interface BundlePaths {
  tarballPath: string;
  metaPath: string;
}

export interface ExtractOptions {
  /** Destination dir — typically `~/.gezel/service/` or the system-scope service home. */
  installDir: string;
  /** Path to `service-bundle.tar.gz`. */
  tarballPath: string;
  /** Path to `service-bundle.meta.json`. */
  metaPath: string;
  logger?: { info?: (m: string) => void; warn?: (m: string) => void };
  /**
   * Force extraction regardless of version comparison. Used by install-time
   * hooks where the destination dir's existing contents (from a partial
   * previous install) shouldn't gate replacement.
   */
  force?: boolean;
}

export interface ExtractResult {
  action: 'fresh-install' | 'upgraded' | 'up-to-date' | 'kept-newer' | 'forced';
  installedVersion: string;
  shippedVersion: string;
}

/**
 * Resolve the tarball + meta sidecar paths relative to the Electron main
 * process's own location.
 *
 * - **Dev**: returns `packages/app/dist/service-bundle.{tar.gz,meta.json}`.
 *   These only exist after `pnpm build:bundle` has been run.
 * - **Packaged**: rewrites the natural `app.asar/dist/...` path to
 *   `app.asar.unpacked/dist/...` — same redirect today's `defaultBundleDir`
 *   uses, same rationale (see redirectAsarToUnpacked).
 */
export function defaultBundlePaths(mainMetaUrl: string): BundlePaths {
  const mainDir = dirname(fileURLToPath(mainMetaUrl));
  const naturalTarball = resolve(mainDir, 'service-bundle.tar.gz');
  const naturalMeta = resolve(mainDir, 'service-bundle.meta.json');
  return {
    tarballPath: redirectAsarToUnpacked(naturalTarball),
    metaPath: redirectAsarToUnpacked(naturalMeta),
  };
}

/**
 * If the path falls inside `…/app.asar/`, rewrite it to the
 * sibling `…/app.asar.unpacked/`. No-op for paths outside an asar
 * (dev mode, tests). Exported because the main process also uses this to
 * find the UI dir.
 */
export function redirectAsarToUnpacked(p: string): string {
  const winMatch = p.match(/^(.*?)(\\app\.asar)(\\.*|$)/);
  if (winMatch) return `${winMatch[1]}\\app.asar.unpacked${winMatch[3]}`;
  const posixMatch = p.match(/^(.*?)(\/app\.asar)(\/.*|$)/);
  if (posixMatch) return `${posixMatch[1]}/app.asar.unpacked${posixMatch[3]}`;
  return p;
}

/**
 * Read the shipped bundle's meta sidecar. Returns null if missing or
 * malformed — callers fall through to "no shipped bundle available" which
 * is the right behavior in dev and when the install is broken.
 */
export async function readBundleMeta(metaPath: string): Promise<BundleMeta | null> {
  try {
    const raw = await readFile(metaPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<BundleMeta>;
    if (
      typeof parsed.version !== 'string' ||
      typeof parsed.sha256 !== 'string' ||
      typeof parsed.sizeBytes !== 'number' ||
      typeof parsed.fileCount !== 'number'
    ) {
      return null;
    }
    return parsed as BundleMeta;
  } catch {
    return null;
  }
}

/**
 * Extract the shipped bundle into `installDir` if it's newer than (or
 * absent from) the install. Never downgrades.
 *
 * Decision order (after the force-extract escape hatch):
 *   1. Empty install dir → fresh-install.
 *   2. Sentinel sha matches shipped sha → up-to-date (fast path, no version
 *      compare needed). This is the hot path on every Electron launch.
 *   3. Sha differs:
 *      a. shipped version > installed version → upgraded.
 *      b. shipped version < installed version → kept-newer (a dev branch
 *         with a higher version is on disk; respect it).
 *      c. shipped version == installed version → upgraded (treat as a
 *         content-drift refresh). This is the case the user kept hitting
 *         during pre-1.0 development: every build is v0.0.0, so the old
 *         "version compare only" logic reported up-to-date even when the
 *         tarball had been completely rebuilt with new deps.
 */
export async function extractBundleIfNeeded(opts: ExtractOptions): Promise<ExtractResult> {
  const { installDir, tarballPath, metaPath, logger, force } = opts;

  await recoverInterruptedInstall(installDir);

  if (!existsSync(tarballPath)) {
    throw new Error(
      `Expected service bundle at ${tarballPath}. Run \`pnpm build:bundle\` to produce it.`,
    );
  }
  const meta = await readBundleMeta(metaPath);
  if (!meta) {
    throw new Error(
      `Expected service bundle meta at ${metaPath}. Run \`pnpm build:bundle\` to produce it.`,
    );
  }
  const shippedVersion = meta.version;
  const shippedSha = meta.sha256.toLowerCase();

  if (force) {
    logger?.info?.(
      `[supervisor] force-extracting service bundle v${shippedVersion} to ${installDir}`,
    );
    await installTarball(tarballPath, installDir, meta);
    return { action: 'forced', installedVersion: shippedVersion, shippedVersion };
  }

  const installedVersion = existsSync(join(installDir, 'package.json'))
    ? await readPackageVersion(join(installDir, 'package.json'))
    : null;

  if (installedVersion === null) {
    logger?.info?.(`[supervisor] extracting service bundle v${shippedVersion} to ${installDir}`);
    await installTarball(tarballPath, installDir, meta);
    return { action: 'fresh-install', installedVersion: shippedVersion, shippedVersion };
  }

  const installedSha = await readShaSentinel(installDir);
  if (installedSha !== null && installedSha === shippedSha) {
    return { action: 'up-to-date', installedVersion, shippedVersion };
  }

  // Sha differs (or sentinel missing — treat as "we don't know what's
  // there"). Fall back to version compare to decide direction.
  const cmp = compareVersions(shippedVersion, installedVersion);
  if (cmp < 0) {
    logger?.warn?.(
      `[supervisor] keeping installed service v${installedVersion} (newer than bundled v${shippedVersion})`,
    );
    return { action: 'kept-newer', installedVersion, shippedVersion };
  }

  // cmp >= 0 — either a true upgrade, or content drift at the same
  // version. Either way the user wants the shipped bytes on disk.
  if (cmp > 0) {
    logger?.info?.(
      `[supervisor] upgrading service install ${installedVersion} → ${shippedVersion}`,
    );
  } else if (installedSha === null) {
    logger?.info?.(
      `[supervisor] re-extracting service bundle v${shippedVersion} (no sha sentinel — older install layout)`,
    );
  } else {
    logger?.info?.(
      `[supervisor] re-extracting service bundle v${shippedVersion} (content drift: shipped sha=${shippedSha.slice(0, 12)} installed sha=${installedSha.slice(0, 12)})`,
    );
  }
  await installTarball(tarballPath, installDir, meta);
  return { action: 'upgraded', installedVersion: shippedVersion, shippedVersion };
}

async function installTarball(tarballPath: string, dest: string, meta: BundleMeta): Promise<void> {
  const tarballStat = await stat(tarballPath);
  if (tarballStat.size !== meta.sizeBytes) {
    throw new Error(
      `[supervisor] service bundle size mismatch (tarball=${tarballStat.size} expected=${meta.sizeBytes}) — refusing to extract`,
    );
  }
  // Verify the tarball hashes to the sha the meta sidecar declares before
  // we extract + execute its contents. The tarball + meta ship together
  // inside the signed/notarized app, so this is integrity/corruption
  // protection rather than authentication — a deeper guarantee against
  // post-extraction tampering of the user-writable install dir would
  // require running the service from a non-user-writable location.
  const actualSha = createHash('sha256')
    .update(await readFile(tarballPath))
    .digest('hex');
  if (actualSha.toLowerCase() !== meta.sha256.toLowerCase()) {
    throw new Error(
      `[supervisor] service bundle sha mismatch (tarball=${actualSha.slice(0, 12)} expected=${meta.sha256.slice(0, 12)}) — refusing to extract`,
    );
  }
  const staging = `${dest}.staging-${process.pid}-${randomUUID()}`;
  const backup = `${dest}.previous`;
  await mkdir(dirname(dest), { recursive: true });
  await mkdir(staging, { recursive: true });
  try {
    await tar.extract({ file: tarballPath, cwd: staging, strict: true, preservePaths: false });
  } catch (err) {
    await rm(staging, { recursive: true, force: true });
    throw err;
  }
  try {
    // `fileCount` used to be write-only metadata. A Windows release proved
    // that a tarball can pass size/SHA validation yet leave an incomplete
    // extracted dependency tree. Count regular files + symlinks before the
    // staging swap so a partial install never becomes the live service.
    const extractedFileCount = await countExtractedBundleFiles(staging);
    if (extractedFileCount !== meta.fileCount) {
      throw new Error(
        `[supervisor] post-extract file count mismatch (extracted=${extractedFileCount} expected=${meta.fileCount})`,
      );
    }

    // Ensure the bin stays executable on POSIX. Tarballs preserve modes, but
    // belt-and-braces it for cross-platform safety.
    const gezeldBin = join(staging, 'dist', 'bin', 'gezeld.js');
    if (existsSync(gezeldBin)) {
      try {
        const { chmod } = await import('node:fs/promises');
        await chmod(gezeldBin, 0o755);
      } catch {
        /* best-effort */
      }
    }
    const st = await stat(gezeldBin);
    if (!st.isFile()) {
      throw new Error(`[supervisor] post-extract verify failed: ${gezeldBin} is not a file`);
    }
    const stagedVersion = await readPackageVersion(join(staging, 'package.json'));
    if (stagedVersion !== meta.version) {
      throw new Error(
        `[supervisor] post-extract verify failed: package version ${stagedVersion} does not match ${meta.version}`,
      );
    }
    await writeShaSentinel(staging, meta.sha256.toLowerCase());
  } catch (err) {
    await rm(staging, { recursive: true, force: true });
    throw err;
  }

  // Commit only after the staged tree is complete and executable. Keep the
  // prior install available for rollback until the final rename succeeds.
  if (existsSync(backup)) await rm(backup, { recursive: true, force: true });
  const hadLiveInstall = existsSync(dest);
  if (hadLiveInstall) await rename(dest, backup);
  try {
    await rename(staging, dest);
  } catch (err) {
    if (hadLiveInstall && existsSync(backup) && !existsSync(dest)) {
      await rename(backup, dest).catch(() => {});
    }
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
  if (existsSync(backup)) await rm(backup, { recursive: true, force: true });
}

async function countExtractedBundleFiles(root: string): Promise<number> {
  let count = 0;
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink() || entry.isFile()) {
        count += 1;
      } else if (entry.isDirectory()) {
        await walk(join(dir, entry.name));
      }
    }
  }
  await walk(root);
  return count;
}

async function recoverInterruptedInstall(dest: string): Promise<void> {
  const backup = `${dest}.previous`;
  if (!existsSync(dest) && existsSync(backup)) await rename(backup, dest);
}

async function readShaSentinel(installDir: string): Promise<string | null> {
  try {
    const raw = await readFile(join(installDir, SHA_SENTINEL), 'utf8');
    const trimmed = raw.trim().toLowerCase();
    return /^[0-9a-f]{64}$/.test(trimmed) ? trimmed : null;
  } catch {
    return null;
  }
}

async function writeShaSentinel(installDir: string, sha: string): Promise<void> {
  await writeFile(join(installDir, SHA_SENTINEL), `${sha}\n`, 'utf8');
}

async function readPackageVersion(path: string): Promise<string> {
  const raw = await readFile(path, 'utf8');
  const parsed = JSON.parse(raw) as { version?: unknown };
  if (typeof parsed.version !== 'string') {
    throw new Error(`[supervisor] ${path} is missing a 'version' field`);
  }
  return parsed.version;
}

/**
 * Tiny semver-ish comparator. Gezel uses plain x.y.z versions; we do not
 * need full semver (prerelease tags, build metadata) here. Returns +/-/0.
 */
export function compareVersions(a: string, b: string): number {
  const as = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const bs = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const len = Math.max(as.length, bs.length);
  for (let i = 0; i < len; i++) {
    const x = as[i] ?? 0;
    const y = bs[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}
