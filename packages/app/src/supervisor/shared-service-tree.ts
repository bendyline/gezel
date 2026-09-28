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
 * The two checks are expressed differently per platform, because the evidence
 * available differs:
 *
 *   - POSIX reads ownership and mode directly. `stat` is nearly free, so
 *     verifying beats trusting. It also asks more than "not ours": the tree
 *     and the directories that hold the entry point must belong to root, as
 *     the installers publish it, because a tree the service account owned was
 *     one that account could rewrite under every other account's daemon.
 *   - Windows cannot. `st.mode` is synthesized there, so the POSIX test would
 *     pass vacuously; and the DACL that carries the real answer is not even
 *     readable — the installer keeps `%ProgramData%\Gezel` private, so an
 *     ordinary account gets ACCESS_DENIED on the tree, on its DACL, and on
 *     `GetNamedSecurityInfo`. A check written against the ACL would therefore
 *     refuse on every machine, forever.
 *
 * Windows instead pairs an elevated attestation with an empirical probe:
 *
 *   - the installer publishes the tree (`Users:(OI)(CI)(RX)`, write left to
 *     SYSTEM/Administrators/the service SID) and, only when that succeeded,
 *     records the published bundle sha under HKLM. HKLM is writable by
 *     administrators alone and readable by everyone, which is exactly the
 *     shape an attestation needs: a low-privilege account can neither forge
 *     the record nor suppress it.
 *   - we then probe the tree, its parent, and the daemon entry for write
 *     access *from this account*, which is the property the POSIX branch
 *     ultimately cares about and the one thing a DACL read would have told us
 *     that the registry cannot.
 *
 * KNOWN ASYMMETRY, stated rather than hidden: the POSIX branch rejects a tree
 * writable by *anyone* outside its owner (`mode & 0o022`); the Windows branch
 * can only prove it is not writable by *us*. A second unprivileged account
 * holding an explicit write ACE would pass here and fail there. Closing that
 * needs an enumerable DACL, which is precisely what we cannot read. It is
 * acceptable because the parent is administrator-only: nothing below it can
 * be created, replaced, or re-permissioned without administrator rights, so
 * such an ACE can only exist if an administrator deliberately granted it —
 * and an administrator is already inside the trust boundary.
 */

import { randomUUID } from 'node:crypto';
import { lstat, open, realpath, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { readBundleMeta, readInstalledBundleSha } from './extract-bundle.js';
import {
  MACHINE_STATE_REGISTRY_KEY,
  type RegQuery,
  defaultRegQuery,
  parseRegSz,
} from './machine-service-state.js';
import { systemServiceHome } from './system-service.js';

/**
 * Registry value the Windows installer writes after publishing the tree.
 * Mirrors `GEZEL_PUBLISHED_TREE_VALUE` in `installer/nsis-hooks.nsh`.
 */
const PUBLISHED_TREE_VALUE = 'SharedServiceTreeSha';

/**
 * Whether this account can write `path`.
 *
 * `unknown` is not `denied`: a probe that failed for a reason other than
 * permissions tells us nothing, and "nothing" must not read as "safe".
 */
export type WriteProbe = (
  path: string,
  kind: 'dir' | 'file',
) => Promise<'writable' | 'denied' | 'unknown'>;

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
  /** Windows only. Injectable so tests never touch the real registry. */
  regQuery?: RegQuery;
  /** Windows only. Injectable so tests need no real ACL to observe. */
  writeProbe?: WriteProbe;
  /**
   * POSIX only. The account the installer publishes the tree as — root.
   * Injectable because a test fixture cannot be owned by root.
   */
  publisherUid?: number;
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
    // On Windows an unpublished tree is unreadable rather than untrusted, so
    // this throws EACCES and the catch below takes the extract path — which is
    // the correct outcome and the ordinary one before the installer that
    // publishes the tree has ever run.
    const entryInfo = await lstat(daemonEntry);
    if (!entryInfo.isFile()) return null;

    const rejection =
      platform === 'win32'
        ? await rejectUntrustedWindowsTree(treeDir, daemonEntry, meta.sha256, opts)
        : await rejectUntrustedTree(treeDir, opts.publisherUid ?? 0);
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
 * Ask the filesystem, rather than the ACL, whether we can write here.
 *
 * A directory is probed by creating a uniquely-named file (`wx`, so it can
 * never clobber anything) and removing it again. A file is probed by opening
 * it `r+`, which requests write access without truncating — the only way to
 * test FILE_WRITE_DATA on an existing file without destroying it.
 */
const defaultWriteProbe: WriteProbe = async (path, kind) => {
  if (kind === 'file') {
    try {
      const handle = await open(path, 'r+');
      await handle.close();
      return 'writable';
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      return code === 'EACCES' || code === 'EPERM' || code === 'EROFS' ? 'denied' : 'unknown';
    }
  }

  const probe = join(path, `.gezel-write-probe-${process.pid}-${randomUUID()}`);
  try {
    const handle = await open(probe, 'wx');
    await handle.close();
    return 'writable';
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'EACCES' || code === 'EPERM' || code === 'EROFS' ? 'denied' : 'unknown';
  } finally {
    // Only ever removes a file this call created: the name is unique and `wx`
    // refuses to open an existing one.
    await rm(probe, { force: true }).catch(() => {});
  }
};

/**
 * Windows counterpart to {@link rejectUntrustedTree}. Returns why the tree
 * must not be executed, or null when it is safe to.
 *
 * See the module comment for why this reads an attestation plus a probe
 * instead of a DACL, and for the one guarantee it gives up.
 */
async function rejectUntrustedWindowsTree(
  treeDir: string,
  daemonEntry: string,
  shippedSha: string,
  opts: SharedServiceTreeOptions,
): Promise<string | null> {
  const regQuery = opts.regQuery ?? defaultRegQuery;
  const probe = opts.writeProbe ?? defaultWriteProbe;

  let published: string | null = null;
  try {
    // reg.exe exits non-zero when the value is absent, which promisified
    // execFile surfaces as a rejection — the ordinary state on any machine
    // whose installer predates tree publishing.
    published = parseRegSz(
      await regQuery(MACHINE_STATE_REGISTRY_KEY, PUBLISHED_TREE_VALUE),
      PUBLISHED_TREE_VALUE,
    );
  } catch {
    published = null;
  }
  if (!published) return 'no elevated installer has published this tree';
  if (published.toLowerCase() !== shippedSha.toLowerCase()) {
    return `the published tree records bundle ${published.slice(0, 12).toLowerCase()}, not the shipped ${shippedSha.slice(0, 12).toLowerCase()}`;
  }

  // Parent first, and it is not redundant: write access to it is rename
  // access to everything below, so being able to swap `<home>\service` for
  // another directory is equivalent to being able to rewrite its contents.
  for (const [path, kind] of [
    [dirname(treeDir), 'dir'],
    [treeDir, 'dir'],
    [daemonEntry, 'file'],
  ] as const) {
    const verdict = await probe(path, kind);
    if (verdict === 'writable') return `${path} accepts writes from this account`;
    if (verdict === 'unknown') return `${path} could not be probed for write access`;
  }
  return null;
}

/**
 * Entries inside the tree whose ownership is checked on every launch. The
 * directories matter more than the files: owning a directory is what stops
 * anyone else renaming, replacing, or adding the entries beneath it. A missing
 * optional entry is skipped; its absence breaks the daemon on its own.
 */
const PUBLISHED_ENTRIES: ReadonlyArray<{ path: readonly string[]; optional?: true }> = [
  { path: ['.gezel-bundle.sha256'] },
  { path: ['package.json'] },
  { path: ['dist'] },
  { path: ['dist', 'bin'] },
  { path: ['dist', 'bin', 'gezeld.js'] },
  { path: ['node_modules'], optional: true },
];

/**
 * Why this tree must not be executed, or null when it is safe to.
 *
 * The parent matters because write access to it is rename access to everything
 * below: being able to swap `<home>/service` for another directory is
 * equivalent to being able to rewrite its contents. It belongs to the service
 * account on every platform — it is that account's home — so it is held only to
 * "not writable by this account or by everyone".
 *
 * The tree itself must belong to the publisher (root). The service account
 * parses untrusted model files, and a tree it owned was one it could rewrite
 * for every account's daemon. Requiring root ownership is also what makes the
 * parent's looser rule sufficient: the only root-owned directory carrying this
 * bundle's sentinel is the one the installer published, so moving another
 * directory into its place cannot pass.
 */
async function rejectUntrustedTree(treeDir: string, publisherUid: number): Promise<string | null> {
  const selfUid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (selfUid === null) return 'this platform does not report a uid';

  // realpath first: a symlinked component means the bytes we would execute
  // are not the ones whose ownership we are about to check.
  const parent = await realpath(dirname(treeDir));
  const parentInfo = await stat(parent);
  if ((parentInfo.mode & 0o022) !== 0) {
    return `${parent} is group- or world-writable (mode ${(parentInfo.mode & 0o7777).toString(8)})`;
  }
  if (selfUid !== 0 && parentInfo.uid === selfUid) {
    return `${parent} is owned by this account, so it carries no more trust than a local extraction`;
  }

  const root = await realpath(treeDir);
  const rootProblem = publishedEntryProblem(root, await stat(root), publisherUid);
  if (rootProblem) return rootProblem;
  for (const entry of PUBLISHED_ENTRIES) {
    const path = join(root, ...entry.path);
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(path);
    } catch (err) {
      if (entry.optional && (err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    // Inside the tree nothing is followed: the installer publishes real
    // entries, and a link would move the check off the bytes that run.
    if (info.isSymbolicLink()) return `${path} is a symlink`;
    const problem = publishedEntryProblem(path, info, publisherUid);
    if (problem) return problem;
  }
  return null;
}

function publishedEntryProblem(
  path: string,
  info: { mode: number; uid: number },
  publisherUid: number,
): string | null {
  if ((info.mode & 0o022) !== 0) {
    return `${path} is group- or world-writable (mode ${(info.mode & 0o7777).toString(8)})`;
  }
  if (info.uid !== publisherUid) {
    return `${path} belongs to uid ${info.uid}, not the installer (uid ${publisherUid})`;
  }
  return null;
}
