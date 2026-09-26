import { posix, win32 } from 'node:path';
import type { InferencePlatform } from './types.js';

/**
 * Platform-explicit path primitives. Never use the host `node:path` here:
 * the daemon decides the platform, and tests exercise all three from any
 * host. Comparison is case-insensitive on Windows and macOS (matching
 * `packages/service/src/fs/safe-paths.ts`), exact on Linux.
 */

export function toInferencePlatform(platform: string): InferencePlatform {
  if (platform === 'win32') return 'win32';
  if (platform === 'darwin') return 'darwin';
  return 'linux';
}

function api(platform: InferencePlatform): typeof posix {
  return platform === 'win32' ? win32 : posix;
}

export function separatorFor(platform: InferencePlatform): string {
  return platform === 'win32' ? '\\' : '/';
}

export function isCaseInsensitive(platform: InferencePlatform): boolean {
  return platform !== 'linux';
}

const BARE_UNC_SERVER = /^\\\\([^\\]+)\\?$/;

/**
 * Case-preserving normalization: separators unified, `.`/`..` resolved,
 * trailing separators dropped (except at a root), Windows extended-length
 * prefixes removed, and drive letters upper-cased for stable display.
 */
export function normalizePath(p: string, platform: InferencePlatform): string {
  if (platform === 'win32') {
    let s = p.replace(/\//g, '\\');
    if (s.startsWith('\\\\?\\UNC\\')) s = `\\\\${s.slice(8)}`;
    else if (s.startsWith('\\\\?\\')) s = s.slice(4);
    // `win32.normalize('\\\\srv')` collapses to `\srv`, losing the UNC shape.
    const bare = BARE_UNC_SERVER.exec(s);
    if (bare) return `\\\\${bare[1]}`;
    s = win32.normalize(s);
    const root = win32.parse(s).root;
    while (s.length > root.length && s.endsWith('\\')) s = s.slice(0, -1);
    if (/^[a-z]:/.test(s)) s = `${s[0]!.toUpperCase()}${s.slice(1)}`;
    return s;
  }
  let s = posix.normalize(p);
  while (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

export function compareKey(p: string, platform: InferencePlatform): string {
  const n = normalizePath(p, platform);
  return isCaseInsensitive(platform) ? n.toLowerCase() : n;
}

export function isAbsolutePath(p: string, platform: InferencePlatform): boolean {
  if (platform === 'win32') {
    return /^[a-zA-Z]:[\\/]/.test(p) || /^[\\/]{2}[^\\/]/.test(p);
  }
  return p.startsWith('/');
}

export function pathsEqual(a: string, b: string, platform: InferencePlatform): boolean {
  return compareKey(a, platform) === compareKey(b, platform);
}

function withTrailingSeparator(key: string, platform: InferencePlatform): string {
  const sep = separatorFor(platform);
  return key.endsWith(sep) ? key : `${key}${sep}`;
}

/** `child` equals `parent` or lies beneath it. `/home/foobar` is not inside `/home/foo`. */
export function isSameOrInside(
  child: string,
  parent: string,
  platform: InferencePlatform,
): boolean {
  const kc = compareKey(child, platform);
  const kp = compareKey(parent, platform);
  if (kc === kp) return true;
  return kc.startsWith(withTrailingSeparator(kp, platform));
}

export function isStrictlyInside(
  child: string,
  parent: string,
  platform: InferencePlatform,
): boolean {
  return !pathsEqual(child, parent, platform) && isSameOrInside(child, parent, platform);
}

/** Parent directory, or `null` at a root. */
export function parentOf(p: string, platform: InferencePlatform): string | null {
  const n = normalizePath(p, platform);
  if (platform === 'win32' && BARE_UNC_SERVER.test(n)) return null;
  const d = normalizePath(api(platform).dirname(n), platform);
  return d === n ? null : d;
}

export function basenameOf(p: string, platform: InferencePlatform): string {
  const n = normalizePath(p, platform);
  return api(platform).basename(n) || n;
}

/** `p` itself, then each parent up to the root. */
export function ancestors(p: string, platform: InferencePlatform): string[] {
  const out: string[] = [];
  let cur: string | null = normalizePath(p, platform);
  while (cur !== null) {
    out.push(cur);
    cur = parentOf(cur, platform);
  }
  return out;
}

/**
 * Segments of `child` below `root`, or `null` when `child` is not inside it.
 * Returns `[]` when they are the same path.
 */
export function segmentsBelow(
  root: string,
  child: string,
  platform: InferencePlatform,
): string[] | null {
  if (!isSameOrInside(child, root, platform)) return null;
  const nr = normalizePath(root, platform);
  const nc = normalizePath(child, platform);
  if (nr.length >= nc.length) return [];
  const rest = nc.slice(withTrailingSeparator(nr, platform).length);
  return rest.split(separatorFor(platform)).filter((s) => s.length > 0);
}

export function depthBetween(
  root: string,
  child: string,
  platform: InferencePlatform,
): number | null {
  const segs = segmentsBelow(root, child, platform);
  return segs === null ? null : segs.length;
}

export function joinPath(platform: InferencePlatform, ...parts: string[]): string {
  return normalizePath(api(platform).join(...parts), platform);
}

export type ParsedRoot =
  | { kind: 'drive'; root: string }
  | { kind: 'unc'; root: string; server: string; share?: string }
  | { kind: 'posix'; root: '/' };

export function parseRoot(p: string, platform: InferencePlatform): ParsedRoot {
  if (platform !== 'win32') return { kind: 'posix', root: '/' };
  const n = normalizePath(p, platform);
  const bare = BARE_UNC_SERVER.exec(n);
  if (bare) return { kind: 'unc', root: n, server: bare[1]! };
  const root = win32.parse(n).root;
  if (root.startsWith('\\\\')) {
    const [server, share] = root
      .slice(2)
      .split('\\')
      .filter((s) => s.length > 0);
    return { kind: 'unc', root, server: server ?? '', ...(share ? { share } : {}) };
  }
  return { kind: 'drive', root };
}
