/**
 * Target-aware reparse-point sweep for the Windows installer.
 *
 * This enforces link policy on a private, already-repaired tree. It is NOT a
 * security boundary for subsequent path-based mutations: a concurrent writer
 * can replace a directory after any preflight. The installer's ACL repair uses
 * pinned no-follow handles instead (installer/windows/ResetTreeAcl.cs).
 *
 * Refusing every link is not the answer either. uv links
 * `cpython-3.12-<triple>` to the patch-version directory beside it, and the
 * video venv's pyvenv.cfg `home` goes through that link; pnpm trees under
 * system-toolsets and shared project workspaces are junction farms. Refusing
 * them made every upgrade of a machine that had run either drop the shared
 * engine, silently under auto-update, and again on every later upgrade.
 *
 * So the rule is where a link leads, not that it exists:
 *   - a link whose target stays inside the swept root is kept: the sweep
 *     reaches that target at its real location anyway;
 *   - a link that leads outside, cannot be resolved, or closes a traversal
 *     cycle is removed. Only the link itself, never its target, and never
 *     recursively.
 *
 * The walk never descends through a link, and treats a directory whose final
 * path is not its own (a volume mount point, which libuv does not report as a
 * link) as one. Each link is judged twice. First by its own text, opening
 * nothing, so the elevated installer never opens a place a planted link names
 * (a symlink to \\host\share would authenticate to that host). Only links
 * whose text stays inside are then resolved physically, which catches chains
 * and `..` through other links. Cycles are removed because a recursive icacls
 * follows them until MAX_PATH, re-sweeping the subtree at every level.
 */
import {
  type Stats,
  lstatSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
} from 'node:fs';
import path from 'node:path';

export type UnsafeLinkReason = 'outside' | 'unresolvable' | 'cycle';

export interface ReparseLinkFinding {
  /** The link entry itself. */
  path: string;
  reason: UnsafeLinkReason;
  /** Where the link leads, when that is known. */
  target: string | null;
  detail: string;
}

export interface ReparseSweepResult {
  mode: 'fix' | 'check';
  /** The swept root as given. */
  root: string;
  /** Its real path; every reported entry lies below it. */
  realRoot: string;
  entries: number;
  /** Reparse points seen, safe or not. */
  links: number;
  /** Links kept because they stay inside the root. */
  kept: number;
  /** Every unsafe link found. In fix mode each is also in `removed` or `failed`. */
  unsafe: ReparseLinkFinding[];
  removed: ReparseLinkFinding[];
  failed: Array<ReparseLinkFinding & { error: string }>;
  /** Directories or entries that could not be inspected, so may hide a link. */
  uninspectable: Array<{ path: string; error: string }>;
}

export class ReparseSweepError extends Error {}

/** Exit codes of the installer CLI. NSIS treats anything but 0 as "do not sweep". */
export const REPARSE_EXIT = {
  clean: 0,
  usage: 1,
  unsafeRemains: 2,
  uninspectable: 3,
} as const;

const LOG_PREFIX = '[neutralize-reparse-points]';

type Platform = NodeJS.Platform;

function pathApi(platform: Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}

/**
 * A path in the form two spellings of one location share. On Windows that
 * drops the `\\?\` verbatim prefix (`\\?\UNC\` becomes `\\`) and folds case,
 * since NTFS names compare case-insensitively.
 */
export function comparablePath(candidate: string, platform: Platform): string {
  if (platform !== 'win32') return path.posix.resolve(candidate);
  let spelled = candidate;
  if (/^\\\\\?\\UNC\\/i.test(spelled)) spelled = `\\\\${spelled.slice(8)}`;
  else if (spelled.startsWith('\\\\?\\')) spelled = spelled.slice(4);
  return path.win32.resolve(spelled).toLowerCase();
}

export function isWithin(candidate: string, root: string, platform: Platform): boolean {
  const inner = comparablePath(candidate, platform);
  const outer = comparablePath(root, platform);
  if (inner === outer) return true;
  const sep = pathApi(platform).sep;
  return inner.startsWith(outer.endsWith(sep) ? outer : outer + sep);
}

/** Where a link's own text points. Relative text resolves against the link's directory. */
export function linkTextTarget(linkPath: string, text: string, platform: Platform): string {
  const api = pathApi(platform);
  return api.resolve(api.dirname(linkPath), text);
}

interface Candidate {
  path: string;
  /** The link's text, resolved; null when it has none we could read. */
  text: string | null;
  /** The physical target, once resolved. */
  real: string | null;
  /**
   * A directory that redirects without reading as a link: libuv reports a
   * mount point naming a volume GUID as a plain directory.
   */
  redirect: boolean;
  error?: string;
  finding?: ReparseLinkFinding;
}

function errorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code: unknown }).code)
    : undefined;
}

function describe(err: unknown): string {
  const code = errorCode(err);
  const message = err instanceof Error ? err.message : String(err);
  return code && !message.startsWith(code) ? `${code}: ${message}` : message;
}

/** Paths are attacker-chosen names; keep each finding on one log line. */
function printable(value: string | null): string {
  if (value === null) return '?';
  let out = '';
  for (const char of value) out += char.charCodeAt(0) < 0x20 || char === '\u007f' ? '?' : char;
  return out;
}

function lowerBound(sorted: readonly string[], value: string): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((sorted[mid] as string) < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Kept links that lie on a traversal cycle: following one eventually reaches a
 * link whose target contains it again. A link pointing at its own ancestor is
 * the one-node case. Links merely leading into a cycle are not on it and stay.
 */
function cycleMembers(nodes: readonly Candidate[], platform: Platform): Set<Candidate> {
  const sep = pathApi(platform).sep;
  const order = nodes
    .map((node, index) => ({ key: comparablePath(node.path, platform), index }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const keys = order.map((entry) => entry.key);
  const edges = nodes.map((node) => {
    const target = comparablePath(node.real as string, platform);
    const prefix = target.endsWith(sep) ? target : target + sep;
    const out: number[] = [];
    for (let at = lowerBound(keys, target); at < keys.length; at++) {
      const key = keys[at] as string;
      if (!key.startsWith(target)) break;
      if (key === target || key.startsWith(prefix))
        out.push((order[at] as { index: number }).index);
    }
    return out;
  });

  // Iterative Tarjan: pnpm trees hold thousands of links.
  const index = new Array<number>(nodes.length).fill(-1);
  const low = new Array<number>(nodes.length).fill(0);
  const onStack = new Array<boolean>(nodes.length).fill(false);
  const stack: number[] = [];
  const members = new Set<Candidate>();
  let counter = 0;
  for (let start = 0; start < nodes.length; start++) {
    if (index[start] !== -1) continue;
    const work: Array<{ node: number; edge: number }> = [{ node: start, edge: 0 }];
    index[start] = low[start] = counter++;
    stack.push(start);
    onStack[start] = true;
    while (work.length > 0) {
      const frame = work[work.length - 1] as { node: number; edge: number };
      const from = frame.node;
      const out = edges[from] as number[];
      if (frame.edge < out.length) {
        const to = out[frame.edge++] as number;
        if (index[to] === -1) {
          index[to] = low[to] = counter++;
          stack.push(to);
          onStack[to] = true;
          work.push({ node: to, edge: 0 });
        } else if (onStack[to]) {
          low[from] = Math.min(low[from] as number, index[to] as number);
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low[parent.node] = Math.min(low[parent.node] as number, low[from] as number);
      if (low[from] !== index[from]) continue;
      const component: number[] = [];
      let member: number;
      do {
        member = stack.pop() as number;
        onStack[member] = false;
        component.push(member);
      } while (member !== from);
      if (component.length > 1 || out.includes(from)) {
        for (const at of component) members.add(nodes[at] as Candidate);
      }
    }
  }
  return members;
}

function removeLink(candidate: Candidate): void {
  if (candidate.redirect) {
    // A directory that redirects without reading as a link (a volume mount
    // point). rmdir deletes that entry, never what it mounts, and refuses a
    // directory with contents of its own.
    rmdirSync(candidate.path);
    return;
  }
  // Re-check right before deleting: an entry swapped for a real file or
  // directory since it was judged is not ours to remove.
  if (!lstatSync(candidate.path).isSymbolicLink()) {
    throw new ReparseSweepError('changed since it was inspected; no longer a link');
  }
  // unlink removes the link itself everywhere. On Windows libuv opens it with
  // FILE_FLAG_OPEN_REPARSE_POINT, which is how it deletes a junction or a
  // directory symlink as readily as a file symlink, and refuses a real
  // directory. (rmdir is no substitute: it answers ENOENT for a file symlink.)
  unlinkSync(candidate.path);
}

/**
 * Walk `root` without following links and judge every reparse point in it.
 * `fix` removes the unsafe ones; `check` only reports them. Throws
 * ReparseSweepError when the root itself cannot be swept safely.
 */
export function sweepReparsePoints(opts: {
  root: string;
  mode: 'fix' | 'check';
  /**
   * Subtrees the removing pass must not modify: an unsafe link whose own path
   * lies within one is refused (counted as a failure, so the run fails closed)
   * rather than deleted. The data-root sweep names the world-writable shared
   * tree here, so an elevated delete only ever runs where the install has
   * already closed the directory to unprivileged principals. It has no effect
   * in check mode, which deletes nothing.
   */
  noRemoveUnder?: readonly string[];
  log?: (line: string) => void;
}): ReparseSweepResult {
  const platform = process.platform;
  const api = pathApi(platform);
  const log = opts.log ?? (() => {});
  const root = api.resolve(opts.root);

  let rootStats: Stats;
  try {
    rootStats = lstatSync(root);
  } catch (err) {
    throw new ReparseSweepError(`cannot inspect ${root}: ${describe(err)}`);
  }
  if (rootStats.isSymbolicLink()) {
    throw new ReparseSweepError(`${root} is itself a link; refusing to sweep through it`);
  }
  if (!rootStats.isDirectory()) throw new ReparseSweepError(`${root} is not a directory`);
  const realRoot = realpathSync.native(root);

  const result: ReparseSweepResult = {
    mode: opts.mode,
    root,
    realRoot,
    entries: 0,
    links: 0,
    kept: 0,
    unsafe: [],
    removed: [],
    failed: [],
    uninspectable: [],
  };

  // An entry the listing names but lstat cannot find either vanished (a
  // running per-user daemon renames temp files in shared projects) or has a
  // name that does not survive the round trip through a JS string, such as an
  // unpaired UTF-16 surrogate. Only the first is safe to skip.
  const stillListed = (dir: string, name: string): boolean => {
    try {
      return readdirSync(dir).includes(name);
    } catch {
      return false;
    }
  };

  const candidates: Candidate[] = [];
  const pending = [realRoot];
  while (pending.length > 0) {
    const dir = pending.pop() as string;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch (err) {
      if (dir !== realRoot && errorCode(err) === 'ENOENT') continue;
      result.uninspectable.push({ path: dir, error: describe(err) });
      continue;
    }
    for (const name of names) {
      const entry = api.join(dir, name);
      result.entries += 1;
      let stats: Stats;
      try {
        stats = lstatSync(entry);
      } catch (err) {
        if (errorCode(err) === 'ENOENT' && !stillListed(dir, name)) continue;
        result.uninspectable.push({ path: entry, error: describe(err) });
        continue;
      }
      if (stats.isSymbolicLink()) {
        try {
          const text = linkTextTarget(entry, readlinkSync(entry), platform);
          candidates.push({ path: entry, text, real: null, redirect: false });
        } catch (err) {
          candidates.push({
            path: entry,
            text: null,
            real: null,
            redirect: false,
            error: describe(err),
          });
        }
        continue;
      }
      if (!stats.isDirectory()) continue;
      // A plain directory's final path is its own. Anything else redirects
      // traversal even though lstat did not call it a link.
      let real: string;
      try {
        real = realpathSync.native(entry);
      } catch (err) {
        if (errorCode(err) === 'ENOENT' && !stillListed(dir, name)) continue;
        candidates.push({
          path: entry,
          text: null,
          real: null,
          redirect: true,
          error: describe(err),
        });
        continue;
      }
      if (comparablePath(real, platform) === comparablePath(entry, platform)) pending.push(entry);
      else candidates.push({ path: entry, text: null, real, redirect: true });
    }
  }
  result.links = candidates.length;

  // Link text may spell the root as given rather than as resolved (macOS's
  // /var is /private/var); walked entries always use the resolved spelling.
  const inRealRoot = (candidatePath: string): string =>
    !isWithin(candidatePath, realRoot, platform) && isWithin(candidatePath, root, platform)
      ? api.join(realRoot, api.relative(root, candidatePath))
      : candidatePath;

  // Protected subtrees compared in the same resolved spelling as walked
  // entries, so a given `--no-remove-under` matches regardless of symlinked
  // ancestors (macOS's /var -> /private/var).
  const protectedRoots = (opts.noRemoveUnder ?? []).map((entry) => inRealRoot(api.resolve(entry)));
  const isProtected = (candidatePath: string): boolean =>
    protectedRoots.some((prot) => isWithin(candidatePath, prot, platform));

  const flag = (
    candidate: Candidate,
    reason: UnsafeLinkReason,
    target: string | null,
    detail: string,
  ) => {
    const finding: ReparseLinkFinding = { path: candidate.path, reason, target, detail };
    candidate.finding = finding;
    result.unsafe.push(finding);
    if (opts.mode === 'check') {
      log(
        `${LOG_PREFIX} unsafe ${reason} link ${printable(candidate.path)} -> ${printable(target)} (${printable(detail)})`,
      );
      return;
    }
    if (isProtected(candidate.path)) {
      // The elevated process must not delete here: an unprivileged principal
      // can still write this subtree at sweep time, so a parent component
      // could be swapped for a junction between the check and the unlink,
      // turning a delete into an arbitrary-file delete. Fail the install
      // closed instead, naming the path so an operator can clear it.
      const error = 'under a path this phase must not modify; refusing (install fails closed)';
      result.failed.push({ ...finding, error });
      log(
        `${LOG_PREFIX} REFUSED to remove ${reason} link ${printable(candidate.path)} -> ${printable(target)}: ${printable(error)}`,
      );
      return;
    }
    try {
      removeLink(candidate);
      result.removed.push(finding);
      log(
        `${LOG_PREFIX} removed ${reason} link ${printable(candidate.path)} -> ${printable(target)} (${printable(detail)})`,
      );
    } catch (err) {
      const error = describe(err);
      result.failed.push({ ...finding, error });
      log(
        `${LOG_PREFIX} FAILED to remove ${reason} link ${printable(candidate.path)} -> ${printable(target)}: ${printable(error)}`,
      );
    }
  };

  // Every reparse point, keyed by its comparable path, so a chain can be
  // followed through the candidate map by text alone — never by realpath,
  // which would physically open whatever the chain ultimately names.
  const byPath = new Map<string, Candidate>();
  for (const candidate of candidates)
    byPath.set(comparablePath(candidate.path, platform), candidate);
  const rootKey = comparablePath(realRoot, platform);

  // The longest candidate link that is `comparable` itself or an ancestor of
  // it: the first reparse point a walk of that path would cross.
  const candidateAt = (comparable: string): Candidate | undefined => {
    let at = comparable;
    for (;;) {
      const hit = byPath.get(at);
      if (hit) return hit;
      if (at === rootKey) return undefined;
      const parent = api.dirname(at);
      if (parent === at) return undefined;
      at = parent;
    }
  };

  // What a hop continues through: a symlink's own text, or a mount point's
  // already-known physical target. Returned comparable, like `candidateAt`.
  const hopTarget = (candidate: Candidate): string | null => {
    const raw = candidate.redirect ? candidate.real : candidate.text;
    return raw === null ? null : comparablePath(inRealRoot(raw), platform);
  };

  type ChainResult =
    | { kind: 'through'; target: string; via: string }
    | { kind: 'cycle'; target: string }
    | { kind: 'safe'; terminal: string };

  // Follow a link's chain through the candidate map by text, hop by hop, with
  // a visited set. It opens nothing: an outside-pointing link is already
  // flagged (pass 1 for a direct one, an earlier round for a transitive one),
  // so a chain that would leave the root always meets a flagged link first and
  // stops there. A chain that stays inside ends at a real path; only then does
  // the caller touch the filesystem, with a single lstat on that in-root path.
  const resolveChain = (start: Candidate): ChainResult => {
    let target = comparablePath(inRealRoot(start.text as string), platform);
    const visited = new Set<string>([comparablePath(start.path, platform)]);
    for (;;) {
      const hop = candidateAt(target);
      if (hop === undefined) return { kind: 'safe', terminal: target };
      const hopKey = comparablePath(hop.path, platform);
      if (visited.has(hopKey)) return { kind: 'cycle', target };
      if (hop.finding) return { kind: 'through', target, via: hop.path };
      const base = hopTarget(hop);
      if (base === null) return { kind: 'through', target, via: hop.path };
      visited.add(hopKey);
      const rest = target.slice(hopKey.length);
      target = rest === '' ? base : base + rest;
    }
  };

  // Pass 1 opens nothing: it judges each link by its own text (and each mount
  // point by the physical target the walk already read), so the chain walk
  // below meets every directly-outside link already flagged.
  for (const candidate of candidates) {
    if (candidate.redirect) {
      if (candidate.real === null) {
        flag(candidate, 'unresolvable', null, `redirecting directory: ${candidate.error}`);
      } else if (!isWithin(candidate.real, realRoot, platform)) {
        flag(candidate, 'outside', candidate.real, 'redirects outside the root');
      }
    } else if (candidate.text === null) {
      flag(candidate, 'unresolvable', null, `link text unreadable: ${candidate.error}`);
    } else if (
      !isWithin(candidate.text, realRoot, platform) &&
      !isWithin(candidate.text, root, platform)
    ) {
      flag(candidate, 'outside', candidate.text, 'points outside the root');
    }
  }

  // Resolve the rest by text, then drop containment cycles among the links
  // that survive (a kept link whose target holds it again makes a recursive
  // icacls re-descend without end). Repeat until nothing new is flagged: a
  // removed cycle member leaves anything that went through it dangling, and a
  // link accepted before a hop of its was flagged must be reconsidered.
  for (;;) {
    const flaggedBefore = result.unsafe.length;
    for (const candidate of candidates) {
      if (candidate.finding || candidate.redirect) continue;
      const chain = resolveChain(candidate);
      if (chain.kind === 'through') {
        flag(candidate, 'unresolvable', chain.target, `goes through unsafe link ${chain.via}`);
      } else if (chain.kind === 'cycle') {
        flag(candidate, 'cycle', chain.target, 'traversal through it returns to itself');
      } else {
        try {
          // The terminal is an in-root path reached only through real
          // directories, so this lstat cannot follow a planted link outside.
          lstatSync(chain.terminal);
          candidate.real = chain.terminal;
        } catch (err) {
          const detail = errorCode(err) === 'ENOENT' ? 'target does not exist' : describe(err);
          flag(candidate, 'unresolvable', chain.terminal, detail);
        }
      }
    }
    const survivors = candidates.filter((candidate) => !candidate.finding);
    const cyclic = cycleMembers(survivors, platform);
    for (const candidate of cyclic) {
      flag(candidate, 'cycle', candidate.real, 'traversal through it returns to itself');
    }
    if (result.unsafe.length === flaggedBefore) break;
  }

  for (const candidate of candidates) {
    if (!candidate.finding) result.kept += 1;
  }
  return result;
}

export function sweepIsClean(result: ReparseSweepResult): boolean {
  return (
    result.failed.length === 0 &&
    result.uninspectable.length === 0 &&
    (result.mode === 'fix' || result.unsafe.length === 0)
  );
}

function parseCliArgs(argv: readonly string[]): {
  root: string;
  mode: 'fix' | 'check';
  noRemoveUnder: string[];
} {
  const api = pathApi(process.platform);
  let root = '';
  let mode: 'fix' | 'check' = 'fix';
  const noRemoveUnder: string[] = [];
  for (const arg of argv) {
    if (arg === '--check') mode = 'check';
    else if (arg.startsWith('--root=')) root = arg.slice('--root='.length);
    else if (arg.startsWith('--no-remove-under=')) {
      // The NSIS caller always passes this define; an empty expansion means
      // "nothing protected" rather than an error.
      const value = arg.slice('--no-remove-under='.length);
      if (value !== '') {
        if (!api.isAbsolute(value)) {
          throw new ReparseSweepError(`--no-remove-under must be absolute: ${value}`);
        }
        noRemoveUnder.push(value);
      }
    } else throw new ReparseSweepError(`unknown argument: ${arg}`);
  }
  if (!root) throw new ReparseSweepError('--root=<absolute directory> is required');
  if (!api.isAbsolute(root)) {
    throw new ReparseSweepError(`--root must be absolute: ${root}`);
  }
  return { root, mode, noRemoveUnder };
}

/** The installer CLI. Returns the process exit code; see REPARSE_EXIT. */
export function runReparseSweepCli(
  argv: readonly string[],
  io: { out: (line: string) => void; err: (line: string) => void },
): number {
  const started = Date.now();
  let result: ReparseSweepResult;
  try {
    const args = parseCliArgs(argv);
    result = sweepReparsePoints({
      ...args,
      log: (line) =>
        line.includes(' FAILED ') || line.includes(' REFUSED ') ? io.err(line) : io.out(line),
    });
  } catch (err) {
    io.err(`${LOG_PREFIX} FAILED: ${printable(err instanceof Error ? err.message : String(err))}`);
    return REPARSE_EXIT.usage;
  }
  for (const entry of result.uninspectable) {
    io.err(`${LOG_PREFIX} could not inspect ${printable(entry.path)}: ${printable(entry.error)}`);
  }
  io.out(
    `${LOG_PREFIX} ${result.mode} root=${printable(result.realRoot)} entries=${result.entries} ` +
      `links=${result.links} kept=${result.kept} unsafe=${result.unsafe.length} ` +
      `removed=${result.removed.length} failed=${result.failed.length} ` +
      `uninspectable=${result.uninspectable.length} elapsed=${Date.now() - started}ms`,
  );
  if (result.failed.length > 0 || (result.mode === 'check' && result.unsafe.length > 0)) {
    return REPARSE_EXIT.unsafeRemains;
  }
  if (result.uninspectable.length > 0) return REPARSE_EXIT.uninspectable;
  return REPARSE_EXIT.clean;
}
