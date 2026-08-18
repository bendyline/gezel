import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
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
 * What `installTarball` appends to the install dir to name a staging tree:
 * `.staging-<pid>-<uuid>`. Anchored and shape-checked to the exact uuid
 * layout `randomUUID` produces, because matching this pattern is what
 * selects a directory for recursive deletion in `sweepAbandonedStaging` —
 * a loose prefix match here would be a delete primitive.
 */
const STAGING_SUFFIX =
  /^\.staging-([1-9][0-9]{0,9})-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Read size for the tarball stream. Matches node-tar's own `maxReadSize`
 * default, which is what `tar.extract({ file })` would have used had we let
 * it open the file itself. Node's 64 KiB default would put ~10k extra loop
 * turns between us and a ~700 MB bundle for no benefit.
 */
const TARBALL_READ_SIZE = 16 * 1024 * 1024;

/**
 * Log a progress line once the completed share has advanced this far. Five
 * points is ~20 lines for a full extraction: enough that a stalled install
 * is visibly stalled, few enough that the deb/rpm hook's stdout stays
 * readable in `apt` output.
 */
const PROGRESS_LOG_STEP = 5;

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
 *
 * On platforms with a machine service, the install-time extraction and the
 * first-launch one used to be the *same* work done twice — see
 * {@link ../shared-service-tree.js}, which lets the per-user daemon adopt the
 * installer-owned tree when its sentinel matches this sidecar's sha.
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
   * previous install) shouldn't gate replacement, and where a *downgrade*
   * must still take — an installer is authoritative about what belongs on
   * disk in a way a launching app is not.
   *
   * It does not mean "always re-extract". An exact sha match still
   * short-circuits, because a tree cannot carry a matching sentinel unless a
   * complete extraction committed it: the sentinel is written inside the
   * staging tree and only becomes visible through the final atomic rename.
   * Re-running the same installer therefore no longer re-unpacks ~33k files
   * for nothing.
   */
  force?: boolean;
}

export interface ExtractResult {
  action: 'fresh-install' | 'upgraded' | 'up-to-date' | 'kept-newer' | 'forced';
  installedVersion: string;
  shippedVersion: string;
  /**
   * Wall-clock milliseconds this call spent. Reported for every action so a
   * slow install can be attributed from a log alone — before this, the only
   * evidence a caller had was one line at the start of an extraction and
   * silence until the daemon came up, which is how a 15-minute unpack on a
   * fresh Linux arm64 box read as a hang rather than as work.
   */
  elapsedMs: number;
  /** Files + symlinks written, or null when no extraction ran. */
  filesExtracted: number | null;
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
  const startedAt = Date.now();
  const done = (
    action: ExtractResult['action'],
    installedVersion: string,
    shippedVersion: string,
    filesExtracted: number | null,
  ): ExtractResult => {
    const elapsedMs = Date.now() - startedAt;
    if (filesExtracted !== null) {
      logger?.info?.(
        `[supervisor] extracted service bundle v${shippedVersion} in ${describeDuration(elapsedMs)} ` +
          `(${filesExtracted} files, ${describeRate(filesExtracted, elapsedMs)})`,
      );
    }
    return { action, installedVersion, shippedVersion, elapsedMs, filesExtracted };
  };

  await recoverInterruptedInstall(installDir);
  // Before the bundle checks below, so an orphan is reclaimed on the
  // up-to-date fast path too — otherwise the one case that leaves a staging
  // tree behind (a launch that never completes) is also the case that never
  // extracts again, and the space is never returned.
  await sweepAbandonedStaging(installDir, logger);

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

  const installedVersion = existsSync(join(installDir, 'package.json'))
    ? await readPackageVersion(join(installDir, 'package.json'))
    : null;

  if (force) {
    if (installedVersion !== null && (await readShaSentinel(installDir)) === shippedSha) {
      logger?.info?.(
        `[supervisor] service bundle v${shippedVersion} is already extracted at ${installDir}`,
      );
      return done('up-to-date', installedVersion, shippedVersion, null);
    }
    logger?.info?.(
      `[supervisor] force-extracting service bundle v${shippedVersion} to ${installDir}`,
    );
    const files = await installTarball(tarballPath, installDir, meta, logger);
    return done('forced', shippedVersion, shippedVersion, files);
  }

  if (installedVersion === null) {
    logger?.info?.(`[supervisor] extracting service bundle v${shippedVersion} to ${installDir}`);
    const files = await installTarball(tarballPath, installDir, meta, logger);
    return done('fresh-install', shippedVersion, shippedVersion, files);
  }

  const installedSha = await readShaSentinel(installDir);
  if (installedSha !== null && installedSha === shippedSha) {
    return done('up-to-date', installedVersion, shippedVersion, null);
  }

  // Sha differs (or sentinel missing — treat as "we don't know what's
  // there"). Fall back to version compare to decide direction.
  const cmp = compareVersions(shippedVersion, installedVersion);
  if (cmp < 0) {
    logger?.warn?.(
      `[supervisor] keeping installed service v${installedVersion} (newer than bundled v${shippedVersion})`,
    );
    return done('kept-newer', installedVersion, shippedVersion, null);
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
  const files = await installTarball(tarballPath, installDir, meta, logger);
  return done('upgraded', shippedVersion, shippedVersion, files);
}

/**
 * Extract into a staging tree and return how many files + symlinks landed.
 *
 * The tarball is read exactly once. Its bytes are hashed as they stream
 * through on the way into the untar, rather than by a separate `readFile` +
 * `update()` pass beforehand — that pass doubled the I/O for a ~700 MB
 * archive and allocated the whole thing as one Buffer, both of which are
 * felt on a slow or cold-cache install.
 *
 * ORDERING, DELIBERATE: the integrity check therefore now gates the
 * *commit* rather than the *read*. Nothing is executed, imported, or linked
 * out of the staging tree — the only thing that ever happens to unverified
 * bytes is that they get written to a private staging directory and, on any
 * mismatch, recursively deleted below. The live install dir is only ever
 * reached by a rename that a matching sha is a precondition for. The
 * property this preserves is the one that matters: gezeld never runs from a
 * tree whose bytes did not hash to the sidecar's sha.
 *
 * (The tarball + meta ship together inside the signed/notarized app, so this
 * is integrity/corruption protection rather than authentication either way —
 * see the class comment on BundleMeta.)
 */
async function installTarball(
  tarballPath: string,
  dest: string,
  meta: BundleMeta,
  logger?: ExtractOptions['logger'],
): Promise<number> {
  const tarballStat = await stat(tarballPath);
  if (tarballStat.size !== meta.sizeBytes) {
    throw new Error(
      `[supervisor] service bundle size mismatch (tarball=${tarballStat.size} expected=${meta.sizeBytes}) — refusing to extract`,
    );
  }
  const staging = `${dest}.staging-${process.pid}-${randomUUID()}`;
  const backup = `${dest}.previous`;
  await mkdir(dirname(dest), { recursive: true });
  await mkdir(staging, { recursive: true });

  const hash = createHash('sha256');
  let extractedFileCount = 0;
  let bytesRead = 0;
  let loggedPercent = 0;
  try {
    const extractor = tar.extract({
      cwd: staging,
      strict: true,
      preservePaths: false,
      onentry: (entry) => {
        // Directories are the one entry kind that leaves nothing countable
        // behind — the same rule `inventoryBundleArchivePaths` applies when
        // the release build computes `meta.fileCount`, so the two agree by
        // construction. Hardlinks (`Link`) and symlinks both materialize as
        // filesystem entries and count, which is what the old readdir walk
        // did too; pnpm deploy trees contain both.
        if (entry.type === 'Directory') return;
        extractedFileCount += 1;
        if (meta.fileCount <= 0) return;
        const percent = Math.floor((extractedFileCount / meta.fileCount) * 100);
        if (percent >= loggedPercent + PROGRESS_LOG_STEP && percent < 100) {
          loggedPercent = percent;
          logger?.info?.(
            `[supervisor] extracting service bundle — ${percent}% ` +
              `(${extractedFileCount}/${meta.fileCount} files)`,
          );
        }
      },
    });
    const source = createReadStream(tarballPath, { highWaterMark: TARBALL_READ_SIZE });
    source.on('data', (chunk: string | Buffer) => {
      hash.update(chunk);
      bytesRead += chunk.length;
    });
    await new Promise<void>((resolveDone, reject) => {
      let settled = false;
      const fail = (err: unknown) => {
        if (settled) return;
        settled = true;
        source.destroy();
        reject(err instanceof Error ? err : new Error(String(err)));
      };
      // `close` is what node-tar's own file-mode extract resolves on: Unpack
      // emits `end` only once every pending file write has landed, and the
      // parser turns that into `close` on the next microtask.
      extractor.on('close', () => {
        if (settled) return;
        settled = true;
        resolveDone();
      });
      extractor.on('error', fail);
      source.on('error', fail);
      source.pipe(extractor);
    });
  } catch (err) {
    await rm(staging, { recursive: true, force: true });
    throw err;
  }

  try {
    if (bytesRead !== meta.sizeBytes) {
      throw new Error(
        `[supervisor] service bundle read ${bytesRead} bytes but the sidecar declares ${meta.sizeBytes} — refusing to install`,
      );
    }
    const actualSha = hash.digest('hex').toLowerCase();
    if (actualSha !== meta.sha256.toLowerCase()) {
      throw new Error(
        `[supervisor] service bundle sha mismatch (tarball=${actualSha.slice(0, 12)} expected=${meta.sha256.slice(0, 12)}) — refusing to install`,
      );
    }
    // `fileCount` used to be write-only metadata. A Windows release proved
    // that a tarball can pass size/SHA validation yet leave an incomplete
    // extracted dependency tree. Counting the entries as they are unpacked
    // replaced a second full walk of ~33k paths that existed only to produce
    // this number.
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
  return extractedFileCount;
}

function describeDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 90) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m${String(Math.round(seconds % 60)).padStart(2, '0')}s`;
}

function describeRate(files: number, ms: number): string {
  if (ms <= 0) return 'instant';
  return `${Math.round(files / (ms / 1000))} files/s`;
}

async function recoverInterruptedInstall(dest: string): Promise<void> {
  const backup = `${dest}.previous`;
  if (!existsSync(dest) && existsSync(backup)) await rename(backup, dest);
}

/**
 * Is `pid` a process that currently exists?
 *
 * EPERM means it exists under an identity we cannot signal, which still
 * counts as alive — every answer other than a definite "gone" has to keep
 * the staging tree. A recycled pid therefore makes us skip a directory that
 * was in fact abandoned; that costs one more launch, which is the right
 * side of the trade.
 */
function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Reclaim staging trees abandoned by a process that died mid-extract.
 *
 * `<dest>.previous` self-heals: its name is fixed, so the next install
 * deletes it. A staging tree's name carries the pid and a uuid so two
 * extractions can never collide — and that uniqueness is exactly why
 * nothing ever reclaimed one. A killed extraction left the whole partial
 * tree (~700 MB) behind permanently. On the system-scope service home the
 * desktop user cannot even list that directory, so an interrupted silent
 * auto-update stranded storage no one could find or remove without an
 * administrator.
 *
 * This recursively deletes directories, so it is deliberately narrow and
 * every check fails toward keeping the directory:
 *   - direct siblings of `dest` only, never a recursive search;
 *   - the exact `<basename>.staging-<pid>-<uuid>` shape, anchored;
 *   - a real directory, not a symlink or Windows junction;
 *   - still resolving to a direct child of the install parent, so a
 *     reparse point planted in a staging tree's place cannot redirect the
 *     delete at its target — the same rule the NSIS hooks apply before any
 *     elevated operation under ProgramData;
 *   - never our own pid, and never one whose owner is still running.
 *
 * Failures are logged and swallowed. An orphan we cannot remove must never
 * be the reason an install does not happen.
 */
async function sweepAbandonedStaging(
  dest: string,
  logger?: ExtractOptions['logger'],
): Promise<void> {
  const parent = dirname(dest);
  const base = basename(dest);
  const entries = await readdir(parent, { withFileTypes: true }).catch(() => null);
  const parentReal = await realpath(parent).catch(() => null);
  if (!entries || parentReal === null) return;

  for (const entry of entries) {
    if (!entry.name.startsWith(base)) continue;
    const ownerRaw = STAGING_SUFFIX.exec(entry.name.slice(base.length))?.[1];
    if (!ownerRaw) continue;
    const owner = Number.parseInt(ownerRaw, 10);
    if (!Number.isSafeInteger(owner) || owner <= 0) continue;
    if (owner === process.pid || pidIsAlive(owner)) continue;

    const candidate = join(parent, entry.name);
    try {
      const info = await lstat(candidate);
      if (info.isSymbolicLink() || !info.isDirectory()) continue;
      if (dirname(await realpath(candidate)) !== parentReal) continue;
      await rm(candidate, { recursive: true, force: true });
      logger?.info?.(`[supervisor] removed abandoned service staging tree ${entry.name}`);
    } catch (err) {
      logger?.warn?.(
        `[supervisor] could not remove abandoned staging tree ${entry.name}: ${(err as Error).message}`,
      );
    }
  }
}

/**
 * The sha of the bundle an already-extracted tree was produced from, or null
 * when the tree predates the sentinel / has a corrupt one. Exported so
 * {@link ../shared-service-tree.js} can ask "is the installer-owned tree the
 * same bytes this app ships?" without duplicating the sentinel's format.
 */
export async function readInstalledBundleSha(installDir: string): Promise<string | null> {
  return readShaSentinel(installDir);
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
