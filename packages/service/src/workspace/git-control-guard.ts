import type { Dirent } from 'node:fs';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';

/**
 * The `.git` backstop for scripts gezels write.
 *
 * `run_nodejs_script` and `derive_file` hold write access to the whole
 * workspace through Node's permission model, so the Store's refusal to touch
 * `.git` never sees their writes. A planted `.git/config` (an fsmonitor, a
 * filter, a credential helper), a hook, or a `.git` pointer file aimed at a
 * planted git directory runs commands the next time git runs there, from
 * Gezel or from the person's own editor. So the parts of each `.git` that git
 * reads as instructions are snapshotted before the run and put back after it.
 *
 * Bounded on purpose: `.git` entries at the workspace root and two levels
 * below it, where Gezel's own git and the person's editor look, skipping
 * `node_modules`. Every git Gezel runs also turns fsmonitor off, and hooks
 * for anything but the person's own commit or push, so a repository planted
 * deeper, or a change the person's editor reads before the run ends, is not
 * the only thing standing between a script and a command (see
 * `git/config-overrides.ts`).
 */

/** Files in a git directory whose content can name a program or redirect git to another one. */
const CONTROL_FILES = ['config', 'config.worktree', 'commondir', join('info', 'attributes')];
const HOOKS = 'hooks';
const SCAN_DEPTH = 2;
const MAX_DIRS_SCANNED = 2_000;
const SKIP_DIRS = new Set(['node_modules']);

type EntryKind = 'dir' | 'file' | 'link';

/** Folders inside a git directory that hold control files, and may be links. */
const CONTROL_DIRS = ['info', HOOKS];

type GitEntrySnapshot =
  | {
      kind: 'dir';
      /** Control file → bytes, or null when it did not exist. */
      files: Map<string, Buffer | null>;
      /** Every name in `hooks/` (files, and anything else, which is left alone). */
      hookNames: Set<string>;
      hookFiles: Map<string, Buffer>;
      /**
       * Control folders that were already links (a team's shared hooks
       * folder) → their targets. Left alone while they still point there.
       */
      linkedDirs: Map<string, string>;
    }
  | { kind: 'file'; content: Buffer }
  | { kind: 'link'; target: string };

export interface GitControlSnapshot {
  root: string;
  entries: ReadonlyMap<string, GitEntrySnapshot>;
  /** The scan stopped at its folder cap, so a `.git` it did not see may predate the run. */
  truncated: boolean;
  takenAt: number;
}

/** What a repository folder the run created is renamed to, beside where it was. */
export const SET_ASIDE_GIT_DIR = '.git.gezel-set-aside';

export async function snapshotGitControl(workspaceDir: string): Promise<GitControlSnapshot> {
  const takenAt = Date.now();
  const entries = new Map<string, GitEntrySnapshot>();
  const scan = await findGitEntries(workspaceDir);
  for (const [path, kind] of scan.found) {
    const snapshot = await snapshotEntry(path, kind);
    if (snapshot) entries.set(path, snapshot);
  }
  return { root: workspaceDir, entries, truncated: scan.truncated, takenAt };
}

/**
 * Put back every `.git` change the run made; a note for the run's output, or
 * null.
 *
 * A repository folder is never deleted: it holds history (unpushed commits,
 * branches, stashes) that nothing else has. One that reappears elsewhere with
 * the config of a repository that vanished is that repository, moved, and gets
 * its control files back. Any other new one is renamed to
 * {@link SET_ASIDE_GIT_DIR} beside where it was, so git stops reading it as
 * instructions and the person can rename it back. A new `.git` file or link
 * holds no history, only a pointer, and is removed.
 */
export async function restoreGitControl(snapshot: GitControlSnapshot): Promise<string | null> {
  const restored: string[] = [];
  const setAside: string[] = [];
  const rel = (path: string) => relative(snapshot.root, path).split(sep).join('/');
  const note = (path: string) => restored.push(rel(path));

  const now = (await findGitEntries(snapshot.root)).found;
  const vanished = [...snapshot.entries].filter(
    (entry): entry is [string, Extract<GitEntrySnapshot, { kind: 'dir' }>] =>
      entry[1].kind === 'dir' && !now.has(entry[0]),
  );
  for (const [path, kind] of now) {
    if (snapshot.entries.has(path)) continue;
    if (kind !== 'dir') {
      await removeEntry(path);
      note(path);
      continue;
    }
    const config = await readRegularFile(join(path, 'config'));
    const moved = vanished.findIndex(([, before]) => {
      const was = before.files.get('config') ?? null;
      return was !== null && config !== null && was.equals(config);
    });
    const match = vanished[moved];
    if (match) {
      vanished.splice(moved, 1);
      for (const changed of await restoreGitDir(path, match[1])) note(join(path, changed));
      continue;
    }
    if (snapshot.truncated && (await predates(path, snapshot.takenAt))) continue;
    const target = await setAsideGitDir(path);
    if (target) setAside.push(`${rel(path)} as ${rel(target)}`);
    else note(path);
  }

  for (const [path, before] of snapshot.entries) {
    const kind = now.get(path);
    if (before.kind === 'dir') {
      if (kind === 'dir') {
        for (const changed of await restoreGitDir(path, before)) note(join(path, changed));
      } else if (kind) {
        // A repository replaced by a file or link: the history went with the
        // script's own act, but the replacement must not be left to steer git.
        await removeEntry(path);
        note(path);
      }
      continue;
    }
    if (before.kind === 'file') {
      const current = kind === 'file' ? await readFile(path).catch(() => null) : null;
      if (current?.equals(before.content)) continue;
      await removeEntry(path);
      await writeFile(path, before.content);
      note(path);
      continue;
    }
    if (kind === 'link' && (await readlink(path).catch(() => null)) === before.target) continue;
    if (kind) await removeEntry(path);
    note(path);
  }

  const notes: string[] = [];
  if (restored.length > 0) {
    notes.push(
      `[gezel] Put back ${restored.join(', ')}: the script changed git's own files, which git reads as instructions and can run commands from. Leave .git folders alone.`,
    );
  }
  if (setAside.length > 0) {
    notes.push(
      `[gezel] Set aside ${setAside.join(', ')}: the script made a git repository, and git could run commands from its files. Nothing in it was deleted; rename it back to .git if you trust it.`,
    );
  }
  return notes.length > 0 ? notes.join('\n') : null;
}

/** Whether `path` was created before `when` (false when the file system cannot say). */
async function predates(path: string, when: number): Promise<boolean> {
  const stat = await lstat(path).catch(() => null);
  return stat !== null && stat.birthtimeMs > 0 && stat.birthtimeMs < when;
}

/**
 * Rename a repository folder the run made so git no longer reads it, keeping
 * every byte. Returns where it went, or null when it could not be moved (it is
 * then removed, as before, since leaving it would let git run its files).
 */
async function setAsideGitDir(path: string): Promise<string | null> {
  const dir = dirname(path);
  for (let n = 0; n < 50; n++) {
    const target = join(dir, n === 0 ? SET_ASIDE_GIT_DIR : `${SET_ASIDE_GIT_DIR}-${n + 1}`);
    if (await lstat(target).catch(() => null)) continue;
    try {
      await rename(path, target);
      return target;
    } catch {
      break;
    }
  }
  await removeEntry(path);
  return null;
}

async function snapshotEntry(path: string, kind: EntryKind): Promise<GitEntrySnapshot | null> {
  if (kind === 'file') {
    const content = await readFile(path).catch(() => null);
    return content ? { kind: 'file', content } : null;
  }
  if (kind === 'link') {
    const target = await readlink(path).catch(() => null);
    return target === null ? null : { kind: 'link', target };
  }
  const linkedDirs = new Map<string, string>();
  for (const name of CONTROL_DIRS) {
    const target = await linkTarget(join(path, name));
    if (target !== null) linkedDirs.set(name, target);
  }
  const files = new Map<string, Buffer | null>();
  for (const name of CONTROL_FILES) {
    if (linkedDirs.has(firstSegment(name))) continue;
    files.set(name, await readRegularFile(join(path, name)));
  }
  const hookNames = new Set<string>();
  const hookFiles = new Map<string, Buffer>();
  for (const entry of await readDirEntries(join(path, HOOKS))) {
    hookNames.add(entry.name);
    if (!entry.isFile()) continue;
    const content = await readFile(join(path, HOOKS, entry.name)).catch(() => null);
    if (content) hookFiles.set(entry.name, content);
  }
  return { kind: 'dir', files, hookNames, hookFiles, linkedDirs };
}

/** Restore one git directory's control files; the relative paths changed. */
async function restoreGitDir(
  gitDir: string,
  before: Extract<GitEntrySnapshot, { kind: 'dir' }>,
): Promise<string[]> {
  const changed: string[] = [];
  // A control folder the run replaced with a link: unlink it before anything
  // below reads, deletes or writes a path through it.
  const keptLinks = new Set<string>();
  for (const name of CONTROL_DIRS) {
    const full = join(gitDir, name);
    const target = await linkTarget(full);
    if (target === null) continue;
    if (before.linkedDirs.get(name) === target) {
      keptLinks.add(name);
      continue;
    }
    await removeEntry(full);
    changed.push(name);
  }

  for (const [name, content] of before.files) {
    if (keptLinks.has(firstSegment(name))) continue;
    const full = join(gitDir, name);
    const current = await readRegularFile(full);
    const exists = await lstat(full).then(
      () => true,
      () => false,
    );
    if (content === null ? !exists : current?.equals(content)) continue;
    await removeEntry(full);
    if (content !== null) await writeBeneath(gitDir, name, content);
    changed.push(name);
  }

  if (keptLinks.has(HOOKS)) return changed;
  const hooksDir = join(gitDir, HOOKS);
  for (const entry of await readDirEntries(hooksDir)) {
    if (before.hookNames.has(entry.name)) continue;
    await removeEntry(join(hooksDir, entry.name));
    changed.push(join(HOOKS, entry.name));
  }
  for (const [name, content] of before.hookFiles) {
    const full = join(hooksDir, name);
    if ((await readRegularFile(full))?.equals(content)) continue;
    await removeEntry(full);
    await writeBeneath(gitDir, join(HOOKS, name), content);
    changed.push(join(HOOKS, name));
  }
  return changed;
}

/**
 * The `.git` entries a run can plant or change, keyed by absolute path. Never
 * follows a link: a linked directory is not descended, and a `.git` that is a
 * link is reported as one.
 */
async function findGitEntries(
  root: string,
): Promise<{ found: Map<string, EntryKind>; truncated: boolean }> {
  const found = new Map<string, EntryKind>();
  let frontier = [root];
  let scanned = 0;
  for (let depth = 0; depth <= SCAN_DEPTH && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const dir of frontier) {
      if (++scanned > MAX_DIRS_SCANNED) return { found, truncated: true };
      for (const entry of await readDirEntries(dir)) {
        const full = join(dir, entry.name);
        if (entry.name.toLowerCase() === '.git') {
          if (entry.isSymbolicLink()) found.set(full, 'link');
          else if (entry.isDirectory()) found.set(full, 'dir');
          else found.set(full, 'file');
          continue;
        }
        if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) next.push(full);
      }
    }
    frontier = next;
  }
  return { found, truncated: false };
}

/** Where a link points, or null when `path` is not a link. */
async function linkTarget(path: string): Promise<string | null> {
  const stat = await lstat(path).catch(() => null);
  if (!stat?.isSymbolicLink()) return null;
  return readlink(path).catch(() => '');
}

function firstSegment(rel: string): string {
  return rel.split(sep)[0] ?? rel;
}

async function readDirEntries(dir: string): Promise<Dirent[]> {
  const stat = await lstat(dir).catch(() => null);
  if (!stat?.isDirectory()) return [];
  return readdir(dir, { withFileTypes: true }).catch(() => []);
}

/** A file's bytes, or null when it is missing or is anything but a regular file. */
async function readRegularFile(path: string): Promise<Buffer | null> {
  const stat = await lstat(path).catch(() => null);
  if (!stat?.isFile()) return null;
  return readFile(path).catch(() => null);
}

/**
 * Removes a file, folder or link. A link (a Windows junction included) is
 * unlinked itself, never emptied: it may point out of the workspace.
 */
async function removeEntry(path: string): Promise<void> {
  const stat = await lstat(path).catch(() => null);
  if (!stat) return;
  if (stat.isSymbolicLink()) {
    await unlink(path);
    return;
  }
  await rm(path, { recursive: true, force: true });
}

/** Write `rel` beneath `gitDir`, replacing any link on the way rather than writing through it. */
async function writeBeneath(gitDir: string, rel: string, content: Buffer): Promise<void> {
  const parts = rel.split(sep);
  let dir = gitDir;
  for (const part of parts.slice(0, -1)) {
    dir = join(dir, part);
    const stat = await lstat(dir).catch(() => null);
    if (stat && !stat.isDirectory()) await removeEntry(dir);
    await mkdir(dir, { recursive: true });
  }
  const full = join(gitDir, rel);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content);
}
