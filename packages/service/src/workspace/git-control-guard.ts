import type { Dirent } from 'node:fs';
import { lstat, mkdir, readFile, readdir, readlink, rm, unlink, writeFile } from 'node:fs/promises';
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
 * `node_modules`. Every git Gezel runs also turns fsmonitor and hooks off, so
 * a repository planted deeper, or a change the person's editor reads before
 * the run ends, is not the only thing standing between a script and a
 * command (see `git/config-overrides.ts`).
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
}

export async function snapshotGitControl(workspaceDir: string): Promise<GitControlSnapshot> {
  const entries = new Map<string, GitEntrySnapshot>();
  for (const [path, kind] of await findGitEntries(workspaceDir)) {
    const snapshot = await snapshotEntry(path, kind);
    if (snapshot) entries.set(path, snapshot);
  }
  return { root: workspaceDir, entries };
}

/** Put back every `.git` change the run made; a note for the run's output, or null. */
export async function restoreGitControl(snapshot: GitControlSnapshot): Promise<string | null> {
  const restored: string[] = [];
  const note = (path: string) => restored.push(relative(snapshot.root, path).split(sep).join('/'));

  const now = await findGitEntries(snapshot.root);
  for (const path of now.keys()) {
    if (snapshot.entries.has(path)) continue;
    await removeEntry(path);
    note(path);
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

  if (restored.length === 0) return null;
  return `[gezel] Put back ${restored.join(', ')}: the script changed git's own files, which git reads as instructions and can run commands from. Leave .git folders alone.`;
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
async function findGitEntries(root: string): Promise<Map<string, EntryKind>> {
  const found = new Map<string, EntryKind>();
  let frontier = [root];
  let scanned = 0;
  for (let depth = 0; depth <= SCAN_DEPTH && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const dir of frontier) {
      if (++scanned > MAX_DIRS_SCANNED) return found;
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
  return found;
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
