import { constants } from 'node:fs';
import { access, readdir, readlink, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * Node's permission model checks the path a script names, and the kernel
 * then follows any link on it, so a link already in the workspace (a cloned
 * repository's `r -> /`, a `link:` dependency) lets a script read and write
 * wherever it points: `~/.bashrc`, another project's index, the daemon's
 * `/proc/<pid>/mem`. A script cannot make such a link itself (the permission
 * model refuses `symlink`, `link` and renames out), so checking before the run
 * is enough. An OS sandbox that confines the file system by real path
 * (Seatbelt, the Windows container) makes this unnecessary.
 */

/** Past this many entries the folder is too large to check before every run. */
export const MAX_LINK_SCAN_ENTRIES = 500_000;
const SCAN_CONCURRENCY = 16;

export interface EscapingLink {
  path: string;
  target: string;
}

export type LinkScanResult =
  | { ok: true; entries: number }
  | { ok: false; reason: 'links'; links: EscapingLink[] }
  | { ok: false; reason: 'too-large'; entries: number };

/**
 * A link that leads to a system file this account can read but not change:
 * owned by root and not writable, like a virtual environment's
 * `bin/python3 -> /usr/bin/python3`. Reading through it reaches nothing a
 * script could not read by name, and a write through it fails at the kernel,
 * so it is no way out. Refusing it blocked every script in a folder holding a
 * standard Python `.venv` on Linux (1.26326.112 release audit). POSIX only.
 */
export async function isProtectedSystemTarget(target: string): Promise<boolean> {
  if (process.platform === 'win32') return false;
  const info = await stat(target).catch(() => null);
  if (!info || info.uid !== 0) return false;
  return access(target, constants.W_OK).then(
    () => false,
    () => true,
  );
}

function insideAny(path: string, roots: readonly string[], caseInsensitive: boolean): boolean {
  const norm = (p: string) => (caseInsensitive ? p.toLowerCase() : p);
  return roots.some((root) => {
    // Across Windows drives `relative` answers an absolute path.
    const rel = relative(norm(root), norm(path));
    return rel === '' || !(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel));
  });
}

/**
 * Where a link leads. A dangling one is resolved by hand, because writing
 * through it creates its target.
 */
async function linkTarget(link: string): Promise<string> {
  try {
    return await realpath(link);
  } catch {
    let raw: string;
    try {
      raw = await readlink(link);
    } catch {
      return link;
    }
    let pending = resolve(dirname(link), raw);
    const tail: string[] = [];
    for (;;) {
      try {
        return join(await realpath(pending), ...tail.reverse());
      } catch {
        const parent = dirname(pending);
        if (parent === pending) return resolve(dirname(link), raw);
        tail.push(pending.slice(parent.length).replace(/^[\\/]+/, ''));
        pending = parent;
      }
    }
  }
}

export async function findEscapingLinks(
  scanRoots: readonly string[],
  allowedRoots: readonly string[],
  opts: {
    maxEntries?: number;
    platform?: NodeJS.Platform;
    maxReported?: number;
    /** Test seam: whether a target outside every root is a protected system file. */
    systemTarget?: (target: string) => Promise<boolean>;
  } = {},
): Promise<LinkScanResult> {
  const systemTarget = opts.systemTarget ?? isProtectedSystemTarget;
  // Both sides are realpaths, which carry the canonical case on macOS too.
  const caseInsensitive = (opts.platform ?? process.platform) === 'win32';
  const maxEntries = opts.maxEntries ?? MAX_LINK_SCAN_ENTRIES;
  const maxReported = opts.maxReported ?? 3;
  const allowed = await Promise.all(allowedRoots.map((root) => realpath(root).catch(() => root)));
  const links: EscapingLink[] = [];
  const queue = [...scanRoots];
  let entries = 0;
  let active = 0;
  let stopped = false;

  await new Promise<void>((done) => {
    const pump = () => {
      if (stopped || (queue.length === 0 && active === 0)) {
        if (active === 0) done();
        return;
      }
      while (!stopped && active < SCAN_CONCURRENCY && queue.length > 0) {
        const dir = queue.pop() as string;
        active += 1;
        void visit(dir).finally(() => {
          active -= 1;
          pump();
        });
      }
    };
    const visit = async (dir: string) => {
      const list = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of list) {
        if (stopped) return;
        entries += 1;
        if (entries > maxEntries) {
          stopped = true;
          return;
        }
        const full = join(dir, entry.name);
        if (entry.isSymbolicLink()) {
          const target = await linkTarget(full);
          if (!insideAny(target, allowed, caseInsensitive) && !(await systemTarget(target))) {
            links.push({ path: full, target });
            if (links.length >= maxReported) stopped = true;
          }
        } else if (entry.isDirectory()) {
          queue.push(full);
        }
      }
    };
    pump();
  });

  if (links.length > 0) return { ok: false, reason: 'links', links };
  if (entries > maxEntries) return { ok: false, reason: 'too-large', entries };
  return { ok: true, entries };
}

export function escapingLinkRefusal(result: Exclude<LinkScanResult, { ok: true }>): string {
  if (result.reason === 'too-large') {
    return `[sandbox error] This folder holds more than ${MAX_LINK_SCAN_ENTRIES.toLocaleString('en-US')} files and folders, too many to check for links that lead out of it before running a script, so the script was not started.`;
  }
  const named = result.links.map((link) => `${link.path} -> ${link.target}`).join('; ');
  return `[sandbox error] This folder holds a link that leads out of it (${named}). A script could read and change files through it that it is not allowed to reach, so it was not started. Remove the link, or replace it with a copy of what it points to.`;
}
