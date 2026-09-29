import {
  isSameOrInside,
  isStrictlyInside,
  joinPath,
  normalizePath,
  parentOf,
  parseRoot,
  pathsEqual,
  segmentsBelow,
} from './path-compare.js';
import type { ForbiddenContext, ForbiddenReason, InferencePlatform } from './types.js';

/**
 * Folders gezel must never turn into a project root: a drive, the user's
 * home, AppData, the temp dir, gezel's own home, system directories.
 *
 * Two shapes of rule:
 *   - "equal" rules (roots, home, containers, mount points, cloud parents)
 *     forbid the folder itself; a project BELOW it is fine.
 *   - "inside" rules (system dirs, app data, dot-dirs, temp, gezel home)
 *     forbid the folder and everything beneath it.
 *
 * These rules govern CREATING a root. An existing project at an odd
 * location still matches, with a warning, so a user's past choice is never
 * silently undone.
 *
 * A folder the caller names itself (VS Code, the CLI, an app binding its
 * folder) is an explicit choice, not a guess, so the "inside" rules narrow to
 * the broad folders themselves: the temp dir, a system dir or its direct
 * children, AppData / ~/Library and their direct children, a home dot-dir.
 * A project in /tmp/scratch or ~/.config/nvim is then allowed, while an
 * attachment gezel finds in a temp folder still never becomes a project.
 * Gezel's own homes stay forbidden throughout: they hold credentials.
 */

export interface ForbiddenRootOptions {
  /** The caller named this folder; see the module comment. */
  explicit?: boolean;
}

export type ForbiddenPredicate = (
  path: string,
  ctx: ForbiddenContext,
  opts?: ForbiddenRootOptions,
) => boolean;

function home(ctx: ForbiddenContext): string {
  return normalizePath(ctx.homedir, ctx.platform);
}

function insideAny(path: string, roots: readonly string[], platform: InferencePlatform): boolean {
  return roots.some((r) => r && isSameOrInside(path, r, platform));
}

/** `path` is `root` or at most `depth` levels below it. */
function withinDepth(path: string, root: string, depth: number, platform: InferencePlatform) {
  const segs = root ? segmentsBelow(root, path, platform) : null;
  return segs !== null && segs.length <= depth;
}

function withinDepthOfAny(
  path: string,
  roots: readonly string[],
  depth: number,
  platform: InferencePlatform,
): boolean {
  return roots.some((r) => withinDepth(path, r, depth, platform));
}

function equalsAny(path: string, roots: readonly string[], platform: InferencePlatform): boolean {
  return roots.some((r) => r && pathsEqual(path, r, platform));
}

export const isFilesystemRoot: ForbiddenPredicate = (path, ctx) => {
  const parsed = parseRoot(path, ctx.platform);
  return pathsEqual(path, parsed.root, ctx.platform);
};

/** `\\server` or `\\server\share` — a network location, never a project. */
export const isNetworkRoot: ForbiddenPredicate = (path, ctx) => {
  if (ctx.platform !== 'win32') return false;
  const parsed = parseRoot(path, ctx.platform);
  if (parsed.kind !== 'unc') return false;
  return pathsEqual(path, parsed.root, ctx.platform);
};

/** A removable/network volume's mount point (`/Volumes/USB`, `/media/me/USB`). */
export const isMountRoot: ForbiddenPredicate = (path, ctx) => {
  const n = normalizePath(path, ctx.platform);
  if (ctx.platform === 'darwin') {
    const segs = segmentsBelow('/Volumes', n, 'darwin');
    return segs !== null && segs.length <= 1;
  }
  if (ctx.platform === 'linux') {
    const mnt = segmentsBelow('/mnt', n, 'linux');
    if (mnt !== null && mnt.length <= 1) return true;
    const media = segmentsBelow('/media', n, 'linux');
    if (media !== null && media.length <= 2) return true;
    const runMedia = segmentsBelow('/run/media', n, 'linux');
    return runMedia !== null && runMedia.length <= 2;
  }
  return false;
};

export const isUserHome: ForbiddenPredicate = (path, ctx) =>
  pathsEqual(path, home(ctx), ctx.platform);

/** The directory holding every user's home: `/Users`, `/home`, `C:\Users`. */
export const isHomeContainer: ForbiddenPredicate = (path, ctx) => {
  const { platform } = ctx;
  const homeParent = parentOf(home(ctx), platform);
  if (homeParent && pathsEqual(path, homeParent, platform)) return true;
  if (platform === 'darwin') return equalsAny(path, ['/Users'], platform);
  if (platform === 'linux') return equalsAny(path, ['/home', '/var/home', '/root'], platform);
  const parsed = parseRoot(path, platform);
  if (parsed.kind !== 'drive') return false;
  return pathsEqual(path, joinPath(platform, parsed.root, 'Users'), platform);
};

export const isGezelHome: ForbiddenPredicate = (path, ctx) =>
  insideAny(
    path,
    [
      ctx.gezelHome,
      ctx.machineSharedHome ?? '',
      ctx.externalFolders?.gezels ?? '',
      ctx.externalFolders?.projects ?? '',
    ],
    ctx.platform,
  );

export const isTempDir: ForbiddenPredicate = (path, ctx, opts) => {
  const { platform, env } = ctx;
  const roots = [ctx.tmpdir, env.TEMP ?? '', env.TMP ?? '', env.TMPDIR ?? ''];
  if (ctx.tempRoots) roots.push(...ctx.tempRoots);
  else if (platform === 'darwin')
    roots.push('/tmp', '/private/tmp', '/private/var/folders', '/var/folders');
  else if (platform === 'linux') roots.push('/tmp', '/var/tmp');
  const nonEmpty = roots.filter((r) => r);
  return opts?.explicit ? equalsAny(path, nonEmpty, platform) : insideAny(path, nonEmpty, platform);
};

const WINDOWS_SYSTEM_DIRS = [
  'Windows',
  'Program Files',
  'Program Files (x86)',
  'ProgramData',
  '$Recycle.Bin',
  'System Volume Information',
  'Recovery',
  'PerfLogs',
];
const DARWIN_SYSTEM_DIRS = [
  '/System',
  '/Library',
  '/Applications',
  '/private',
  '/usr',
  '/bin',
  '/sbin',
  '/etc',
  '/var',
  '/cores',
  '/Network',
  '/dev',
  '/opt',
];
const LINUX_SYSTEM_DIRS = [
  '/etc',
  '/usr',
  '/var',
  '/bin',
  '/sbin',
  '/lib',
  '/lib32',
  '/lib64',
  '/libx32',
  '/proc',
  '/sys',
  '/dev',
  '/boot',
  '/run',
  '/snap',
  '/nix',
];
/** Linux paths under a system dir that hold user data (Silverblue homes, udisks mounts). */
const LINUX_SYSTEM_EXCEPTIONS = ['/var/home', '/run/media'];
/** Common places for real work that are system dirs only at the top level. */
const LINUX_EQUAL_ONLY = ['/opt', '/srv'];

/**
 * A system directory or anything beneath it. The user's home is exempt even
 * when it lives under one (`/var/home/<user>` on Fedora Silverblue).
 */
export const isSystemDir: ForbiddenPredicate = (path, ctx, opts) => {
  const { platform } = ctx;
  if (isSameOrInside(path, home(ctx), platform)) return false;
  const matches = (roots: readonly string[]) =>
    opts?.explicit ? withinDepthOfAny(path, roots, 1, platform) : insideAny(path, roots, platform);
  if (platform === 'win32') {
    const parsed = parseRoot(path, platform);
    if (parsed.kind !== 'drive') return false;
    return matches(WINDOWS_SYSTEM_DIRS.map((d) => joinPath(platform, parsed.root, d)));
  }
  if (platform === 'darwin') return matches(DARWIN_SYSTEM_DIRS);
  if (insideAny(path, LINUX_SYSTEM_EXCEPTIONS, platform)) return false;
  if (equalsAny(path, LINUX_EQUAL_ONLY, platform)) return true;
  return matches(LINUX_SYSTEM_DIRS);
};

/**
 * Per-user application data: `%USERPROFILE%\AppData`, `~/Library` (except
 * the cloud-sync roots macOS keeps there), and on Linux the XDG dot-dirs
 * (also caught by {@link isHiddenHomeDir}).
 */
export const isPerUserAppData: ForbiddenPredicate = (path, ctx, opts) => {
  const { platform } = ctx;
  const h = home(ctx);
  const matches = (root: string) =>
    opts?.explicit ? withinDepth(path, root, 1, platform) : isSameOrInside(path, root, platform);
  if (platform === 'win32') return matches(joinPath(platform, h, 'AppData'));
  if (platform === 'darwin') {
    const library = joinPath(platform, h, 'Library');
    if (!isSameOrInside(path, library, platform)) return false;
    const cloudStorage = joinPath(platform, library, 'CloudStorage');
    const mobileDocuments = joinPath(platform, library, 'Mobile Documents');
    if (isStrictlyInside(path, cloudStorage, platform)) return false;
    if (isStrictlyInside(path, mobileDocuments, platform)) return false;
    return matches(library);
  }
  // ~/.config and ~/.cache already play the part of AppData\Roaming; in
  // ~/.local that is `share` and `state`, one level down.
  if (!opts?.explicit) {
    return insideAny(
      path,
      ['.config', '.local', '.cache'].map((d) => joinPath(platform, h, d)),
      platform,
    );
  }
  return (
    withinDepthOfAny(
      path,
      [joinPath(platform, h, '.config'), joinPath(platform, h, '.cache')],
      0,
      platform,
    ) || withinDepth(path, joinPath(platform, h, '.local'), 1, platform)
  );
};

/** `~/.ssh`, `~/.gezel`, `~/.config` … and everything under them. */
export const isHiddenHomeDir: ForbiddenPredicate = (path, ctx, opts) => {
  const segs = segmentsBelow(home(ctx), path, ctx.platform);
  if (segs === null || segs.length === 0 || !segs[0]!.startsWith('.')) return false;
  return opts?.explicit ? segs.length === 1 : true;
};

/** The folders macOS keeps cloud providers in; each child is a root, the parent is not. */
export const isCloudRootParent: ForbiddenPredicate = (path, ctx) => {
  if (ctx.platform !== 'darwin') return false;
  const library = joinPath(ctx.platform, home(ctx), 'Library');
  return equalsAny(
    path,
    [
      joinPath(ctx.platform, library, 'CloudStorage'),
      joinPath(ctx.platform, library, 'Mobile Documents'),
    ],
    ctx.platform,
  );
};

/** Evaluated in order; the first match names the reason. */
export const FORBIDDEN_ROOT_RULES: ReadonlyArray<readonly [ForbiddenReason, ForbiddenPredicate]> = [
  ['network-root', isNetworkRoot],
  ['filesystem-root', isFilesystemRoot],
  ['mount-root', isMountRoot],
  ['user-home', isUserHome],
  ['home-container', isHomeContainer],
  ['gezel-home', isGezelHome],
  ['temp-dir', isTempDir],
  ['system-dir', isSystemDir],
  ['cloud-root-parent', isCloudRootParent],
  ['hidden-home-dir', isHiddenHomeDir],
  ['per-user-app-data', isPerUserAppData],
];

export function forbiddenRootReason(
  path: string,
  ctx: ForbiddenContext,
  opts?: ForbiddenRootOptions,
): ForbiddenReason | null {
  const n = normalizePath(path, ctx.platform);
  for (const [reason, rule] of FORBIDDEN_ROOT_RULES) {
    if (rule(n, ctx, opts)) return reason;
  }
  return null;
}

export function isForbiddenProjectRoot(
  path: string,
  ctx: ForbiddenContext,
  opts?: ForbiddenRootOptions,
): boolean {
  return forbiddenRootReason(path, ctx, opts) !== null;
}
