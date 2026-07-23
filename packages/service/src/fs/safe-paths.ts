import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, normalize, sep } from 'node:path';

/**
 * Shared path-safety primitives. Every write or execution inside a
 * user-supplied path (project workspace, artifacts, documents, etc.)
 * funnels through these helpers so the containment rules stay uniform.
 *
 * Three latent bugs that the raw `normalize(join(base, p)).startsWith(base)`
 * pattern we used before had:
 *
 *   1. `/home/foo` matches `/home/foobar` (no separator terminator).
 *   2. Case-sensitive on Windows / macOS default FS, letting
 *      `C:\USERS\FOO\..` slip past.
 *   3. Doesn't resolve symlinks — a model can create a symlink inside
 *      the workspace pointing at `/etc/hosts`, then write through it.
 *
 * `safeJoin` fixes (1) + (2). `realpathContained` fixes (3).
 */

/**
 * Case-insensitive path compare on Windows + macOS (which default to
 * case-preserving-but-case-insensitive filesystems). On Linux, an exact
 * match is required — it's a case-sensitive FS, and being lenient there
 * would weaken the check.
 */
function pathEq(a: string, b: string): boolean {
  if (process.platform === 'win32' || process.platform === 'darwin') {
    return a.toLowerCase() === b.toLowerCase();
  }
  return a === b;
}

function pathStartsWithDir(candidate: string, base: string): boolean {
  if (process.platform === 'win32' || process.platform === 'darwin') {
    return candidate.toLowerCase().startsWith(base.toLowerCase() + sep.toLowerCase());
  }
  return candidate.startsWith(base + sep);
}

/**
 * Belt-and-suspenders for the model that echoes an absolute path back
 * into a workspace tool. The standing prompt conceals the workspace's
 * host path, but absolute paths still leak in from git output, error
 * strings, or a user paste — and `safeJoin` refuses every one of them
 * ({@link safeJoin} rejects `isAbsolute`), which historically surfaced as
 * an indistinguishable "missing" and led a security-review gezel to
 * conclude its checkout was gone and confabulate over files it could not
 * see.
 *
 * This normalizes at the workspace boundary, BEFORE the safe primitives:
 *   - a relative path passes through untouched (the common case);
 *   - an absolute path *inside* `base` is rebased to workspace-relative
 *     (equal-to-base collapses to `''`), so the model's naive call just
 *     works — containment is unchanged because the rebased path still
 *     flows through `safeJoin` + `realpathContained` downstream;
 *   - an absolute path *outside* `base` throws an actionable
 *     `PathSafetyError` instead of a silent miss, so the model is told to
 *     use a workspace-relative path and can self-correct.
 *
 * The comparison is lexical (normalized, platform-case-aware) — it never
 * widens access, since the real security enforcement is the downstream
 * realpath containment check. `safeJoin`'s reject-absolute invariant is
 * left intact for defense in depth.
 */
export function intoWorkspaceRelative(base: string, p: string): string {
  if (typeof p !== 'string' || !isAbsolute(p)) return p;
  const normalizedBase = normalize(base);
  const normalizedPath = normalize(p);
  if (pathEq(normalizedPath, normalizedBase)) return '';
  if (pathStartsWithDir(normalizedPath, normalizedBase)) {
    // Slice by prefix length rather than `path.relative`: containment is
    // already proven (case-insensitively on macOS/Windows), and `relative`
    // is case-SENSITIVE on posix, so a differently-cased-but-contained
    // path would wrongly yield a `../` escape. Slicing keeps the tail's
    // real casing.
    return normalizedPath.slice(normalizedBase.length + sep.length);
  }
  throw new PathSafetyError(
    `absolute path outside the workspace: ${p} — pass a path relative to the workspace root`,
    'path-traversal',
  );
}

/**
 * Resolve `relPath` against `base` and return the resulting absolute
 * path ONLY if it stays inside `base`. Returns `null` on any attempt to
 * escape (`..`, absolute paths, Windows drive swaps, etc.).
 *
 * Both the base and the candidate are normalized before comparison, and
 * the containment check requires a trailing separator OR exact match so
 * `/home/foo` does not pass for `/home/foobar`. Case comparison follows
 * the platform FS convention.
 */
export function safeJoin(base: string, relPath: string): string | null {
  if (typeof relPath !== 'string') return null;
  // Apply Windows' dangerous-name rules on every platform. Workspaces and
  // archives are routinely moved between OSes; allowing ADS syntax, device
  // names, or normalization-ambiguous trailing dots elsewhere creates files
  // that become unsafe as soon as the project reaches Windows.
  if (hasUnsafePortableSegment(relPath)) return null;
  if (isAbsolute(relPath)) return null;
  const normalizedBase = normalize(base);
  const candidate = normalize(join(normalizedBase, relPath));
  if (pathEq(candidate, normalizedBase)) return candidate;
  if (pathStartsWithDir(candidate, normalizedBase)) return candidate;
  return null;
}

/**
 * After `safeJoin` returns a logically-contained path, still verify
 * with `realpath` that any symlinks along the way don't escape. The
 * target file itself might not exist yet (writes), so we realpath the
 * nearest existing ancestor.
 *
 * Returns true if the real path is inside the real base, false
 * otherwise. The caller should treat false as "refuse the op."
 */
export async function realpathContained(base: string, fullPath: string): Promise<boolean> {
  const realBase = await realpathSafe(base);
  if (!realBase) return false;
  const realTarget = await realpathNearest(fullPath);
  if (!realTarget) return false;
  if (pathEq(realTarget, realBase)) return true;
  return pathStartsWithDir(realTarget, realBase);
}

async function realpathSafe(p: string): Promise<string | null> {
  try {
    return normalize(await realpath(p));
  } catch {
    return null;
  }
}

/**
 * `realpath` the given path if it exists, else walk up to the nearest
 * existing ancestor and realpath that + append the un-realpath'd tail.
 * This gives us a meaningful symlink-resolved path even for files that
 * don't exist yet (common during `writeFile`).
 */
async function realpathNearest(p: string): Promise<string | null> {
  const direct = await realpathSafe(p);
  if (direct) return direct;
  const parent = dirname(p);
  if (parent === p) return null; // reached root
  const realParent = await realpathNearest(parent);
  if (!realParent) return null;
  return normalize(join(realParent, basename(p)));
}

/**
 * Windows forbids files named after legacy DOS devices. Creating them
 * tends to break Explorer, crashes some editors, and is almost always
 * a mistake. Reject at the boundary so gezels on any platform can't
 * produce a file that'll blow up on a Windows teammate's checkout.
 *
 * The check is on the basename only — a directory somewhere in the
 * path can legitimately be called `conference` without matching `CON`.
 */
const RESERVED_WINDOWS_BASENAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
]);

export function isReservedWindowsName(name: string): boolean {
  if (!name) return false;
  // Strip an extension before comparing — `CON.txt` is also reserved.
  const normalized = name.replace(/[ .]+$/g, '');
  const base = (normalized.split('.')[0] ?? '').replace(/[ ]+$/g, '');
  return RESERVED_WINDOWS_BASENAMES.has(base.toUpperCase());
}

function hasUnsafePortableSegment(relPath: string): boolean {
  if (relPath.includes('\0') || relPath.startsWith('\\\\')) return true;
  const segments = relPath.split(/[\\/]+/);
  return segments.some((segment) => {
    if (!segment || segment === '.' || segment === '..') return false;
    if (segment.includes(':') || /[ .]$/.test(segment)) return true;
    return isReservedWindowsName(segment);
  });
}

export class PathSafetyError extends Error {
  readonly code: 'path-traversal' | 'symlink-escape' | 'reserved-name' | 'empty-path';
  constructor(
    message: string,
    code: 'path-traversal' | 'symlink-escape' | 'reserved-name' | 'empty-path',
  ) {
    super(message);
    this.name = 'PathSafetyError';
    this.code = code;
  }
}

/**
 * End-to-end safe resolution: normalize, verify containment, realpath
 * to catch symlink escape, reject reserved Windows basenames. Throws
 * `PathSafetyError` on any violation so callers get a single catch
 * for the whole class of "this path isn't allowed" errors.
 */
export async function resolveInside(base: string, relPath: string): Promise<string> {
  // Rebase an absolute-under-base path to workspace-relative (or throw on
  // absolute-outside) before the containment checks; a relative path is
  // returned unchanged, so existing callers are unaffected.
  const rebasedPath = intoWorkspaceRelative(base, relPath);
  if (!rebasedPath || rebasedPath.trim() === '') {
    throw new PathSafetyError('empty path', 'empty-path');
  }
  const reservedSegment = rebasedPath.split(/[\\/]+/).find(isReservedWindowsName);
  if (reservedSegment) {
    throw new PathSafetyError(`reserved Windows name: ${reservedSegment}`, 'reserved-name');
  }
  const joined = safeJoin(base, rebasedPath);
  if (joined === null) {
    throw new PathSafetyError(`path escapes the base dir: ${rebasedPath}`, 'path-traversal');
  }
  if (isReservedWindowsName(basename(joined))) {
    throw new PathSafetyError(`reserved Windows name: ${basename(joined)}`, 'reserved-name');
  }
  const contained = await realpathContained(base, joined);
  if (!contained) {
    throw new PathSafetyError(`symlink escape detected for ${rebasedPath}`, 'symlink-escape');
  }
  return joined;
}
