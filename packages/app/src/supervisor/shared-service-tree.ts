/**
 * Adopt the installer-extracted service tree instead of extracting a second,
 * byte-identical copy into the user's home.
 *
 * On every platform with a machine service, a packaged install used to unpack
 * `service-bundle.tar.gz` twice:
 *
 *   1. the deb/rpm `afterInstall` hook (or the PKG postinstall, or the NSIS
 *      custom install hook) extracts it into the system-scope service home,
 *      because the machine daemon runs `<systemHome>/service/dist/bin/gezeld.js`;
 *   2. minutes later the desktop app launches, sees `serviceRole=machine-engine`
 *      — the shared broker owns engines only, never product state — resolves a
 *      per-user daemon, and `preparePackagedInstall` unpacks the *same tarball*
 *      into `~/.gezel/service`.
 *
 * Step 2 is pure duplicated work: same sha, same ~33k files, same tarball, a
 * few minutes apart. On a fresh Linux arm64 install that was ~15 minutes at
 * the installer's progress bar followed by ~20 more on the startup splash.
 *
 * Both daemons only ever *read* that tree. `GEZEL_HOME` already separates
 * product state from product code, so the per-user daemon can execute the
 * installer's copy while keeping every gezel, project, and session in the
 * user's own home. That is what this module decides.
 *
 * ADOPTION IS CONDITIONAL, and every check fails toward "extract our own":
 *
 *   - the sentinel in the shared tree must equal the sha of the bundle *this
 *     app* ships. An app-only update (electron-updater replaces the shell but
 *     cannot rewrite the root-owned tree) therefore falls back automatically
 *     rather than running last release's daemon code — the exact skew
 *     `systemServiceVersionSkew` has to report for the machine daemon, and one
 *     we can simply avoid for the user daemon.
 *   - the tree must not be writable by us. A tree the calling account could
 *     rewrite is strictly worse than `~/.gezel/service`, whose contents we at
 *     least verified against a sha'd tarball ourselves; a sentinel file is no
 *     evidence when whoever wrote it could also have written the sentinel.
 *
 * POSIX only, deliberately. The ownership/mode test above is the whole basis
 * for trusting someone else's directory, and it does not exist on Windows —
 * `st.mode` is synthesized there, so the check would pass vacuously on a tree
 * whose real protection lives in an ACL we never read. Windows keeps
 * extracting its own copy until that ACL check is written.
 */

import { lstat, realpath, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { readBundleMeta, readInstalledBundleSha } from './extract-bundle.js';
import { systemServiceHome } from './system-service.js';

export interface SharedServiceTreeOptions {
  /** Path to the shipped `service-bundle.meta.json`. */
  metaPath: string;
  /**
   * Machine-service home. Defaults to {@link systemServiceHome}; tests and the
   * `GEZEL_SYSTEM_SERVICE_HOME` override both flow through that.
   */
  serviceHome?: string | null;
  /** Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  logger?: { info?: (m: string) => void; warn?: (m: string) => void };
}

/**
 * The installer-owned service tree this app may run from, or null when the
 * per-user extraction has to happen. Never throws: a broken or unreadable
 * shared tree is a reason to extract our own, not a reason to fail a launch.
 */
export async function resolveSharedServiceTree(
  opts: SharedServiceTreeOptions,
): Promise<string | null> {
  const platform = opts.platform ?? process.platform;
  if (platform === 'win32') return null;

  const home = opts.serviceHome === undefined ? systemServiceHome(platform) : opts.serviceHome;
  if (!home) return null;
  const treeDir = join(home, 'service');

  try {
    const meta = await readBundleMeta(opts.metaPath);
    if (!meta) return null;
    const installedSha = await readInstalledBundleSha(treeDir);
    if (installedSha === null) return null;
    if (installedSha !== meta.sha256.toLowerCase()) {
      opts.logger?.info?.(
        `[supervisor] machine service tree at ${treeDir} holds a different bundle (installed sha=${installedSha.slice(0, 12)} shipped sha=${meta.sha256.slice(0, 12).toLowerCase()}); extracting this build into the user home`,
      );
      return null;
    }

    const daemonEntry = join(treeDir, 'dist', 'bin', 'gezeld.js');
    const entryInfo = await lstat(daemonEntry);
    if (!entryInfo.isFile()) return null;

    const rejection = await rejectUntrustedTree(treeDir, daemonEntry);
    if (rejection) {
      opts.logger?.warn?.(
        `[supervisor] not adopting the machine service tree at ${treeDir}: ${rejection}`,
      );
      return null;
    }

    opts.logger?.info?.(
      `[supervisor] reusing the installer-extracted service tree at ${treeDir} ` +
        `(sha ${installedSha.slice(0, 12)}) — skipping a duplicate unpack into the user home`,
    );
    return treeDir;
  } catch (err) {
    opts.logger?.info?.(
      `[supervisor] machine service tree unusable (${(err as Error).message}); extracting into the user home`,
    );
    return null;
  }
}

/**
 * Why this tree must not be executed, or null when it is safe to.
 *
 * Checked on the tree root, its parent, and the daemon entry point. The parent
 * matters because write access to it is rename access to everything below:
 * being able to swap `<home>/service` for another directory is equivalent to
 * being able to rewrite its contents.
 */
async function rejectUntrustedTree(treeDir: string, daemonEntry: string): Promise<string | null> {
  const selfUid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (selfUid === null) return 'this platform does not report a uid';

  for (const path of [dirname(treeDir), treeDir, daemonEntry]) {
    // realpath first: a symlinked component means the bytes we would execute
    // are not the ones whose ownership we are about to check.
    const real = await realpath(path);
    const info = await stat(real);
    if ((info.mode & 0o022) !== 0) {
      return `${real} is group- or world-writable (mode ${(info.mode & 0o7777).toString(8)})`;
    }
    // Root is trusted; so is any other service identity. Our own uid is not:
    // an unprivileged account cannot vouch for a tree it could rewrite.
    if (selfUid !== 0 && info.uid === selfUid) {
      return `${real} is owned by this account, so it carries no more trust than a local extraction`;
    }
  }
  return null;
}
