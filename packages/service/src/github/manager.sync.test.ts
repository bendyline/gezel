import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectDetail } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import type { SecretKey, SecretStore, SecretStoreBackend } from '../secrets/types.js';
import { AmbientGithubAuth } from './ambient.js';
import { isGitInstalled, runGit } from './git.js';
import { GitHubManager } from './manager.js';

/**
 * Real-git integration tests for the changes / sync / merge surface. A
 * local bare repo stands in for GitHub (no network); the project's
 * checkout is a worktree off the shared bare clone — the same shape
 * production uses — and a second "colleague" clone pushes the remote-
 * side changes that sync has to integrate.
 */

class InMemorySecrets implements SecretStore {
  readonly backend: SecretStoreBackend = 'file';
  private map = new Map<string, string>();
  private key(k: SecretKey): string {
    if (k.kind === 'toolset') return `t:${k.toolsetId}:${k.fieldId}`;
    if (k.kind === 'providerCredential') return `p:${k.name}`;
    return `k:${k.kind}`;
  }
  async get(k: SecretKey): Promise<string | null> {
    return this.map.get(this.key(k)) ?? null;
  }
  async set(k: SecretKey, v: string): Promise<void> {
    this.map.set(this.key(k), v);
  }
  async delete(k: SecretKey): Promise<void> {
    this.map.delete(this.key(k));
  }
  async has(k: SecretKey): Promise<boolean> {
    return this.map.has(this.key(k));
  }
  async listForToolset(): Promise<string[]> {
    return [];
  }
}

let home: string;
let scratch: string;
let store: Store;
let manager: GitHubManager;
let gitAvailable = true;

/** No ambient credentials — keeps tests hermetic on machines signed into gh. */
function stubAmbient(): AmbientGithubAuth {
  return new AmbientGithubAuth({ env: {}, ghToken: async () => null });
}

beforeEach(async () => {
  gitAvailable = await isGitInstalled();
  home = await mkdtemp(join(tmpdir(), 'gezel-sync-test-'));
  scratch = await mkdtemp(join(tmpdir(), 'gezel-sync-scratch-'));
  store = new Store({ home });
  await store.ensureLayout();
  manager = new GitHubManager(home, store, new InMemorySecrets(), stubAmbient());
});

afterEach(async () => {
  // `git` can still hold a handle on a worktree/pack file for a beat after the
  // child exits; on Windows that surfaces as EBUSY/EPERM on rmdir. `maxRetries`
  // makes node back off and retry instead of failing the test in teardown.
  const opts = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 };
  await rm(home, opts);
  await rm(scratch, opts);
});

/**
 * Local identity for fixture clones. Deliberately does NOT touch
 * core.autocrlf: flipping it after a checkout leaves the index stat
 * cache recording the other ending's file sizes, and git's size-
 * mismatch fast path then reports every file modified forever. The
 * host's setting round-trips cleanly; content assertions normalize
 * line endings instead (see `lf`).
 */
async function configureRepo(dir: string, name: string): Promise<void> {
  await runGit(['config', 'user.email', `${name}@example.com`], { cwd: dir });
  await runGit(['config', 'user.name', name], { cwd: dir });
}

async function commitAll(dir: string, message: string): Promise<void> {
  await runGit(['add', '-A'], { cwd: dir });
  await runGit(['commit', '-m', message, '-q'], { cwd: dir });
}

interface Fixture {
  project: ProjectDetail;
  /** The project's checkout (worktree off the shared bare clone). */
  workdir: string;
  /** Independent clone that plays the "someone else pushed" role. */
  colleague: string;
  upstream: string;
}

/** Upstream bare repo + seeded main + project worktree + colleague clone. */
async function setupFixture(): Promise<Fixture> {
  const upstream = join(scratch, 'upstream.git');
  await mkdir(upstream, { recursive: true });
  await runGit(['init', '--bare', '-q'], { cwd: upstream });
  // Point the bare HEAD at main BEFORE anyone clones — otherwise clones
  // check out an unborn default branch and their pushes to main fail.
  await runGit(['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: upstream });
  const seed = join(scratch, 'seed');
  await mkdir(seed, { recursive: true });
  await runGit(['init', '-q'], { cwd: seed });
  await configureRepo(seed, 'seed');
  await writeFile(join(seed, 'README.md'), 'line one\nline two\nline three\n', 'utf8');
  await writeFile(join(seed, 'notes.txt'), 'original notes\n', 'utf8');
  await writeFile(join(seed, '.gitignore'), 'secret.env\n', 'utf8');
  await commitAll(seed, 'init');
  await runGit(['branch', '-M', 'main'], { cwd: seed });
  await runGit(['remote', 'add', 'origin', upstream], { cwd: seed });
  await runGit(['push', '-u', 'origin', 'main', '-q'], { cwd: seed });

  const created = await store.createProject({ name: 'sync-demo', github: { url: upstream } });
  const workdir = await manager.addProjectWorktree({
    projectId: created.id,
    url: upstream,
    ref: 'main',
  });
  const project = (await store.getProject(created.id)) as ProjectDetail;

  const colleague = join(scratch, 'colleague');
  await runGit(['clone', '-q', upstream, colleague], {});
  await configureRepo(colleague, 'colleague');

  return { project, workdir, colleague, upstream };
}

async function colleaguePush(fix: Fixture, file: string, content: string, msg: string) {
  await writeFile(join(fix.colleague, file), content, 'utf8');
  await commitAll(fix.colleague, msg);
  await runGit(['push', '-q', 'origin', 'main'], { cwd: fix.colleague });
}

async function upstreamHead(fix: Fixture): Promise<string> {
  const { stdout } = await runGit(['rev-parse', 'refs/heads/main'], { cwd: fix.upstream });
  return stdout.trim();
}

const lf = (s: string) => s.replace(/\r\n/g, '\n');

describe('GitHubManager — changes listing + diffs + discard', () => {
  it('lists modified / untracked / deleted changes with stats', async () => {
    if (!gitAvailable) return;
    const fix = await setupFixture();
    await writeFile(join(fix.workdir, 'README.md'), 'line one\nCHANGED\nline three\n', 'utf8');
    await writeFile(join(fix.workdir, 'fresh.md'), 'a\nb\nc\n', 'utf8');
    await rm(join(fix.workdir, 'notes.txt'));

    const { changes, total, truncated } = await manager.listChanges(fix.project);
    expect(total).toBe(3);
    expect(truncated).toBe(false);
    const byPath = new Map(changes.map((c) => [c.path, c]));
    expect(byPath.get('README.md')).toMatchObject({
      kind: 'modified',
      additions: 1,
      deletions: 1,
    });
    expect(byPath.get('fresh.md')).toMatchObject({ kind: 'added', additions: 3, deletions: 0 });
    expect(byPath.get('notes.txt')).toMatchObject({ kind: 'deleted' });
  });

  it('flags untracked binary files instead of counting lines', async () => {
    if (!gitAvailable) return;
    const fix = await setupFixture();
    await writeFile(join(fix.workdir, 'blob.bin'), Buffer.from([1, 2, 0, 4, 5]));
    const { changes } = await manager.listChanges(fix.project);
    expect(changes.find((c) => c.path === 'blob.bin')).toMatchObject({
      kind: 'added',
      binary: true,
    });
  });

  it('produces a unified diff for tracked edits and a synthesized one for untracked files', async () => {
    if (!gitAvailable) return;
    const fix = await setupFixture();
    await writeFile(join(fix.workdir, 'README.md'), 'line one\nCHANGED\nline three\n', 'utf8');
    const tracked = await manager.fileDiff(fix.project, 'README.md');
    expect(tracked.kind).toBe('modified');
    expect(tracked.diff).toContain('-line two');
    expect(tracked.diff).toContain('+CHANGED');

    await writeFile(join(fix.workdir, 'fresh.md'), 'hello\n', 'utf8');
    const untracked = await manager.fileDiff(fix.project, 'fresh.md');
    expect(untracked.kind).toBe('added');
    expect(untracked.additions).toBe(1);
    expect(untracked.diff).toContain('+hello');
  });

  it('rejects unsafe paths', async () => {
    if (!gitAvailable) return;
    const fix = await setupFixture();
    await expect(manager.fileDiff(fix.project, '../outside.txt')).rejects.toThrow(/Invalid path/);
    await expect(manager.fileDiff(fix.project, '--exec=evil')).rejects.toThrow(/Invalid path/);
  });

  it('discards a single tracked edit and deletes a single untracked file', async () => {
    if (!gitAvailable) return;
    const fix = await setupFixture();
    await writeFile(join(fix.workdir, 'README.md'), 'tampered\n', 'utf8');
    await writeFile(join(fix.workdir, 'scratch.md'), 'temp\n', 'utf8');

    await manager.discardChanges(fix.project, { paths: ['README.md'] });
    expect(lf(await readFile(join(fix.workdir, 'README.md'), 'utf8'))).toBe(
      'line one\nline two\nline three\n',
    );
    expect(existsSync(join(fix.workdir, 'scratch.md'))).toBe(true);

    await manager.discardChanges(fix.project, { paths: ['scratch.md'] });
    expect(existsSync(join(fix.workdir, 'scratch.md'))).toBe(false);
  });

  it('discard-all resets everything but preserves gitignored files', async () => {
    if (!gitAvailable) return;
    const fix = await setupFixture();
    await writeFile(join(fix.workdir, 'README.md'), 'tampered\n', 'utf8');
    await writeFile(join(fix.workdir, 'junk.tmp'), 'junk\n', 'utf8');
    await writeFile(join(fix.workdir, 'secret.env'), 'API_KEY=keep-me\n', 'utf8');

    const { discarded } = await manager.discardChanges(fix.project, { all: true });
    expect(discarded).toBe(2); // tampered README + junk.tmp; secret.env is ignored
    expect(lf(await readFile(join(fix.workdir, 'README.md'), 'utf8'))).toBe(
      'line one\nline two\nline three\n',
    );
    expect(existsSync(join(fix.workdir, 'junk.tmp'))).toBe(false);
    expect(existsSync(join(fix.workdir, 'secret.env'))).toBe(true);
  });

  it('lists history with pagination and per-commit detail', async () => {
    if (!gitAvailable) return;
    const fix = await setupFixture();
    await writeFile(join(fix.workdir, 'README.md'), 'second version\n', 'utf8');
    await manager.commit(fix.project, { message: 'Updated the readme' });

    const page1 = await manager.log(fix.project, { limit: 1 });
    expect(page1.commits).toHaveLength(1);
    expect(page1.commits[0]).toMatchObject({ subject: 'Updated the readme', filesChanged: 1 });
    expect(page1.hasMore).toBe(true);

    const page2 = await manager.log(fix.project, { limit: 1, skip: 1 });
    expect(page2.commits[0]?.subject).toBe('init');
    expect(page2.hasMore).toBe(false);

    const detail = await manager.commitDetail(fix.project, page1.commits[0]!.sha);
    expect(detail.subject).toBe('Updated the readme');
    expect(detail.files).toEqual([{ path: 'README.md', additions: 1, deletions: 3 }]);
    expect(detail.diff).toContain('+second version');
  });
});

describe('GitHubManager.sync — state machine', () => {
  it('pulls when the remote is ahead (fast-forward)', async () => {
    if (!gitAvailable) return;
    const fix = await setupFixture();
    await colleaguePush(fix, 'colleague.md', 'from colleague\n', 'colleague work');

    const result = await manager.sync(fix.project);
    expect(result).toMatchObject({ state: 'synced', pulled: 1, pushed: 0 });
    expect(existsSync(join(fix.workdir, 'colleague.md'))).toBe(true);
  });

  it('pushes when local is ahead', async () => {
    if (!gitAvailable) return;
    const fix = await setupFixture();
    await writeFile(join(fix.workdir, 'local.md'), 'local work\n', 'utf8');
    await manager.commit(fix.project, { message: 'local work' });
    const before = await upstreamHead(fix);

    const result = await manager.sync(fix.project);
    expect(result).toMatchObject({ state: 'synced', pulled: 0, pushed: 1 });
    expect(await upstreamHead(fix)).not.toBe(before);
  });

  it('merges cleanly when histories diverge in different files', async () => {
    if (!gitAvailable) return;
    const fix = await setupFixture();
    await colleaguePush(fix, 'theirs.md', 'their side\n', 'their work');
    await writeFile(join(fix.workdir, 'ours.md'), 'our side\n', 'utf8');
    await manager.commit(fix.project, { message: 'our work' });

    const result = await manager.sync(fix.project);
    expect(result).toMatchObject({ state: 'synced', merged: true, pulled: 1, pushed: 2 });
    // Upstream now carries both sides.
    const { stdout } = await runGit(['ls-tree', '--name-only', 'refs/heads/main'], {
      cwd: fix.upstream,
    });
    expect(stdout).toContain('theirs.md');
    expect(stdout).toContain('ours.md');
    // No merge left in progress.
    const ms = await manager.mergeState(fix.project);
    expect(ms.inMerge).toBe(false);
  });

  it('returns needs-save for a dirty tree without touching anything', async () => {
    if (!gitAvailable) return;
    const fix = await setupFixture();
    await writeFile(join(fix.workdir, 'README.md'), 'unsaved edit\n', 'utf8');
    const result = await manager.sync(fix.project);
    expect(result.state).toBe('needs-save');
    expect(lf(await readFile(join(fix.workdir, 'README.md'), 'utf8'))).toBe('unsaved edit\n');
  });

  it('stops on overlapping edits, leaving the merge open with conflict details', async () => {
    if (!gitAvailable) return;
    const fix = await setupFixture();
    await colleaguePush(fix, 'README.md', 'line one\nTHEIR CHANGE\nline three\n', 'their edit');
    await writeFile(join(fix.workdir, 'README.md'), 'line one\nOUR CHANGE\nline three\n', 'utf8');
    await manager.commit(fix.project, { message: 'our edit' });

    const result = await manager.sync(fix.project);
    expect(result.state).toBe('conflicts');
    expect(result.conflictedFiles).toEqual(['README.md']);

    const ms = await manager.mergeState(fix.project);
    expect(ms.inMerge).toBe(true);
    expect(ms.conflicts).toEqual([{ path: 'README.md', kind: 'both-modified' }]);

    const status = await manager.status(fix.project);
    expect(status.mergeInProgress).toBe(true);
    expect(status.conflictedCount).toBe(1);
  });

  it('publishes a brand-new branch when origin has never seen it', async () => {
    if (!gitAvailable) return;
    const fix = await setupFixture();
    await manager.checkoutBranch(fix.project, 'fresh-idea', { create: true });
    await writeFile(join(fix.workdir, 'idea.md'), 'new idea\n', 'utf8');
    await manager.commit(fix.project, { message: 'new idea' });

    const result = await manager.sync(fix.project);
    expect(result.state).toBe('synced');
    expect(result.pushed).toBeGreaterThanOrEqual(1);
    const { stdout } = await runGit(['branch', '--list', 'fresh-idea'], { cwd: fix.upstream });
    expect(stdout).toContain('fresh-idea');
  });
});

describe('GitHubManager — conflict resolution flow', () => {
  /** Drive the fixture into a both-modified conflict on README.md. */
  async function setupConflict(): Promise<Fixture> {
    const fix = await setupFixture();
    await colleaguePush(fix, 'README.md', 'line one\nTHEIR CHANGE\nline three\n', 'their edit');
    await writeFile(join(fix.workdir, 'README.md'), 'line one\nOUR CHANGE\nline three\n', 'utf8');
    await manager.commit(fix.project, { message: 'our edit' });
    const result = await manager.sync(fix.project);
    expect(result.state).toBe('conflicts');
    return fix;
  }

  it('exposes base/ours/theirs versions of a conflicted file', async () => {
    if (!gitAvailable) return;
    const fix = await setupConflict();
    const versions = await manager.conflictFileVersions(fix.project, 'README.md');
    expect(lf(versions.base ?? '')).toBe('line one\nline two\nline three\n');
    expect(lf(versions.ours ?? '')).toBe('line one\nOUR CHANGE\nline three\n');
    expect(lf(versions.theirs ?? '')).toBe('line one\nTHEIR CHANGE\nline three\n');
    expect(versions.binary).toBe(false);
  });

  it('keep-mine resolves, completeMerge commits with two parents, push leg follows', async () => {
    if (!gitAvailable) return;
    const fix = await setupConflict();
    const { remaining } = await manager.resolveConflictFile(fix.project, 'README.md', {
      choice: 'mine',
    });
    expect(remaining).toBe(0);
    expect(lf(await readFile(join(fix.workdir, 'README.md'), 'utf8'))).toBe(
      'line one\nOUR CHANGE\nline three\n',
    );

    const { sha } = await manager.completeMerge(fix.project);
    const { stdout } = await runGit(['rev-list', '--parents', '-n', '1', sha], {
      cwd: fix.workdir,
    });
    expect(stdout.trim().split(/\s+/)).toHaveLength(3); // sha + two parents

    // The follow-up sync sends the merge commit.
    const result = await manager.sync(fix.project);
    expect(result.state).toBe('synced');
    expect(result.pushed).toBeGreaterThanOrEqual(1);
  });

  it('keep-theirs and custom content both settle the file', async () => {
    if (!gitAvailable) return;
    const fix = await setupConflict();
    await manager.resolveConflictFile(fix.project, 'README.md', { choice: 'theirs' });
    expect(lf(await readFile(join(fix.workdir, 'README.md'), 'utf8'))).toBe(
      'line one\nTHEIR CHANGE\nline three\n',
    );
    // Re-resolving a settled file is refused (prevents the deletion
    // fallback from mis-firing after stages are gone).
    await expect(
      manager.resolveConflictFile(fix.project, 'README.md', { choice: 'mine' }),
    ).rejects.toThrow(/already settled/);
  });

  it('custom (AI-combined) content lands and completes', async () => {
    if (!gitAvailable) return;
    const fix = await setupConflict();
    await manager.resolveConflictFile(fix.project, 'README.md', {
      choice: 'custom',
      content: 'line one\nOUR CHANGE\nTHEIR CHANGE\nline three\n',
    });
    const { sha } = await manager.completeMerge(fix.project);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(lf(await readFile(join(fix.workdir, 'README.md'), 'utf8'))).toBe(
      'line one\nOUR CHANGE\nTHEIR CHANGE\nline three\n',
    );
  });

  it('completeMerge refuses while conflicts remain', async () => {
    if (!gitAvailable) return;
    const fix = await setupConflict();
    await expect(manager.completeMerge(fix.project)).rejects.toThrow(/still need a resolution/);
  });

  it('keep-theirs on a deleted-by-them conflict removes the file', async () => {
    if (!gitAvailable) return;
    const fix = await setupFixture();
    await rm(join(fix.colleague, 'notes.txt'));
    await commitAll(fix.colleague, 'delete notes');
    await runGit(['push', '-q', 'origin', 'main'], { cwd: fix.colleague });
    await writeFile(join(fix.workdir, 'notes.txt'), 'our edit to notes\n', 'utf8');
    await manager.commit(fix.project, { message: 'edit notes' });

    const result = await manager.sync(fix.project);
    expect(result.state).toBe('conflicts');
    const ms = await manager.mergeState(fix.project);
    expect(ms.conflicts).toEqual([{ path: 'notes.txt', kind: 'deleted-by-them' }]);

    await manager.resolveConflictFile(fix.project, 'notes.txt', { choice: 'theirs' });
    expect(existsSync(join(fix.workdir, 'notes.txt'))).toBe(false);
    await manager.completeMerge(fix.project);
    expect((await manager.mergeState(fix.project)).inMerge).toBe(false);
  });

  it('abandonMerge restores the exact pre-sync state', async () => {
    if (!gitAvailable) return;
    const fix = await setupConflict();
    const { stdout: before } = await runGit(['rev-parse', 'HEAD'], { cwd: fix.workdir });

    await manager.abandonMerge(fix.project);
    expect((await manager.mergeState(fix.project)).inMerge).toBe(false);
    const { stdout: after } = await runGit(['rev-parse', 'HEAD'], { cwd: fix.workdir });
    expect(after).toBe(before);
    expect(lf(await readFile(join(fix.workdir, 'README.md'), 'utf8'))).toBe(
      'line one\nOUR CHANGE\nline three\n',
    );
    // Abandon again is a harmless no-op.
    await expect(manager.abandonMerge(fix.project)).resolves.toBeUndefined();
  });

  it('survives an app restart mid-merge (state is on disk, not in memory)', async () => {
    if (!gitAvailable) return;
    const fix = await setupConflict();
    // A fresh manager instance over the same home = restarted service.
    const reborn = new GitHubManager(home, store, new InMemorySecrets(), stubAmbient());
    const ms = await reborn.mergeState(fix.project);
    expect(ms.inMerge).toBe(true);
    expect(ms.conflicts[0]?.path).toBe('README.md');
    // sync() short-circuits straight back to the conflict state.
    const result = await reborn.sync(fix.project);
    expect(result.state).toBe('conflicts');
    expect(result.conflictedFiles).toEqual(['README.md']);
  });

  it('discard is refused mid-merge', async () => {
    if (!gitAvailable) return;
    const fix = await setupConflict();
    await expect(manager.discardChanges(fix.project, { paths: ['README.md'] })).rejects.toThrow(
      /finish or cancel/i,
    );
  });
});
