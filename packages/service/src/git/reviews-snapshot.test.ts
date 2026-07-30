import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectDetail } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../fs/store.js';
import { AmbientGitHubAuth } from '../github/ambient.js';
import type { SecretKey, SecretStore, SecretStoreBackend } from '../secrets/types.js';
import { isGitInstalled, runGit } from './git.js';
import {
  DetachedHeadError,
  GitManager,
  NoDefaultBranchError,
  NothingToReviewError,
} from './manager.js';

// Real-git integration tests for the code-review snapshot surface. Same
// fixture idiom as manager.sync.test.ts: a local bare repo stands in for
// GitHub, the project's workingDir is a genuine clone of it.
vi.setConfig({ testTimeout: 30_000 });

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
let manager: GitManager;
let gitAvailable = true;

function stubAmbient(): AmbientGitHubAuth {
  return new AmbientGitHubAuth({ env: {}, ghToken: async () => null });
}

beforeEach(async () => {
  gitAvailable = await isGitInstalled();
  home = await mkdtemp(join(tmpdir(), 'gezel-review-snap-'));
  scratch = await mkdtemp(join(tmpdir(), 'gezel-review-snap-scratch-'));
  store = new Store({ home });
  await store.ensureLayout();
  manager = new GitManager(home, store, new InMemorySecrets(), stubAmbient());
});

afterEach(async () => {
  const opts = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 };
  await rm(home, opts);
  await rm(scratch, opts);
});

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
  workdir: string;
  upstream: string;
}

/** Bare upstream with a seeded main + the project's workingDir clone. */
async function setupFixture(): Promise<Fixture> {
  const upstream = join(scratch, 'upstream.git');
  await mkdir(upstream, { recursive: true });
  await runGit(['init', '--bare', '-q'], { cwd: upstream });
  await runGit(['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: upstream });
  const seed = join(scratch, 'seed');
  await mkdir(seed, { recursive: true });
  await runGit(['init', '-q'], { cwd: seed });
  await configureRepo(seed, 'seed');
  await writeFile(join(seed, 'README.md'), 'line one\nline two\n', 'utf8');
  await writeFile(join(seed, 'src.txt'), 'alpha\nbeta\n', 'utf8');
  await commitAll(seed, 'init');
  await runGit(['branch', '-M', 'main'], { cwd: seed });
  await runGit(['remote', 'add', 'origin', upstream], { cwd: seed });
  await runGit(['push', '-u', 'origin', 'main', '-q'], { cwd: seed });

  const created = await store.createProject({ name: 'review-demo', github: { url: upstream } });
  const workdir = await manager.addProjectWorktree({
    projectId: created.id,
    url: upstream,
    ref: 'main',
  });
  await configureRepo(workdir, 'worker');
  const project = await store.getProject(created.id);
  if (!project) throw new Error('project not found');
  return { project, workdir, upstream };
}

async function freshProject(id: string): Promise<ProjectDetail> {
  const p = await store.getProject(id);
  if (!p) throw new Error('project missing');
  return p;
}

describe('GitManager.defaultBranch', () => {
  it('resolves from the clone, persists onto the project link, and caches', async () => {
    if (!gitAvailable) return;
    const { project } = await setupFixture();
    expect(await manager.defaultBranch(project)).toBe('main');
    const updated = await freshProject(project.id);
    expect(updated.github?.defaultBranch).toBe('main');
    // Cached value wins without touching git at all.
    expect(await manager.defaultBranch(updated)).toBe('main');
  });

  it('falls back to ls-remote when origin/HEAD is unset locally', async () => {
    if (!gitAvailable) return;
    const { project, workdir } = await setupFixture();
    await runGit(['remote', 'set-head', 'origin', '--delete'], { cwd: workdir });
    expect(await manager.defaultBranch(project)).toBe('main');
  });

  it('throws NoDefaultBranchError when nothing resolves', async () => {
    if (!gitAvailable) return;
    const project = await store.createProject({
      name: 'no-repo',
      github: { url: 'https://github.com/octocat/nope' },
    });
    const detail = await store.getProject(project.id);
    await expect(manager.defaultBranch(detail!)).rejects.toBeInstanceOf(NoDefaultBranchError);
  });
});

describe('GitManager.snapshotWorkingChanges', () => {
  it('captures tracked edits + untracked files with a synthesized patch', async () => {
    if (!gitAvailable) return;
    const { project, workdir } = await setupFixture();
    await writeFile(join(workdir, 'src.txt'), 'alpha\nbeta\ngamma\n', 'utf8');
    await writeFile(join(workdir, 'new-file.md'), '# brand new\n', 'utf8');
    const snap = await manager.snapshotWorkingChanges(project);
    expect(snap.kind).toBe('commit');
    expect(snap.branch).toBe('main');
    expect(snap.baseRef).toBe('HEAD');
    const byPath = new Map(snap.files.map((f) => [f.path, f]));
    expect(byPath.get('src.txt')?.kind).toBe('modified');
    expect(byPath.get('new-file.md')?.kind).toBe('added');
    expect(snap.diff).toContain('+gamma');
    expect(snap.diff).toContain('+# brand new');
    expect(snap.diffTruncated).toBe(false);
  });

  it('lists binary untracked files without diffing them', async () => {
    if (!gitAvailable) return;
    const { project, workdir } = await setupFixture();
    await writeFile(join(workdir, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
    const snap = await manager.snapshotWorkingChanges(project);
    const logo = snap.files.find((f) => f.path === 'logo.png');
    expect(logo?.binary).toBe(true);
    expect(snap.diff).not.toContain('logo.png');
    expect(snap.notes.some((n) => n.includes('Binary files'))).toBe(true);
  });

  it('rejects a clean tree with NothingToReviewError', async () => {
    if (!gitAvailable) return;
    const { project } = await setupFixture();
    await expect(manager.snapshotWorkingChanges(project)).rejects.toBeInstanceOf(
      NothingToReviewError,
    );
  });
});

describe('GitManager.snapshotBranchDiff', () => {
  it('captures the branch vs default: files, diff, commits, merge base', async () => {
    if (!gitAvailable) return;
    const { project, workdir } = await setupFixture();
    const mainSha = (await runGit(['rev-parse', 'HEAD'], { cwd: workdir })).stdout.trim();
    await runGit(['checkout', '-q', '-b', 'feature/snappy'], { cwd: workdir });
    await writeFile(join(workdir, 'src.txt'), 'alpha\nbeta\ndelta\n', 'utf8');
    await writeFile(join(workdir, 'feature.md'), 'a feature\n', 'utf8');
    await commitAll(workdir, 'feature work');
    const snap = await manager.snapshotBranchDiff(project);
    expect(snap.kind).toBe('pr');
    expect(snap.branch).toBe('feature/snappy');
    expect(snap.baseRef).toBe('origin/main');
    expect(snap.baseSha).toBe(mainSha);
    const byPath = new Map(snap.files.map((f) => [f.path, f]));
    expect(byPath.get('src.txt')?.kind).toBe('modified');
    expect(byPath.get('feature.md')?.kind).toBe('added');
    expect(snap.diff).toContain('+delta');
    expect(snap.commits).toHaveLength(1);
    expect(snap.commits?.[0]?.subject).toBe('feature work');
  });

  it('ignores uncommitted work — only committed changes are in a branch review', async () => {
    if (!gitAvailable) return;
    const { project, workdir } = await setupFixture();
    await runGit(['checkout', '-q', '-b', 'feature/wip'], { cwd: workdir });
    await writeFile(join(workdir, 'src.txt'), 'alpha\nbeta\ncommitted\n', 'utf8');
    await commitAll(workdir, 'committed change');
    await writeFile(join(workdir, 'src.txt'), 'alpha\nbeta\ncommitted\nuncommitted\n', 'utf8');
    const snap = await manager.snapshotBranchDiff(project);
    expect(snap.diff).toContain('+committed');
    expect(snap.diff).not.toContain('+uncommitted');
  });

  it('rejects on the default branch itself', async () => {
    if (!gitAvailable) return;
    const { project } = await setupFixture();
    await expect(manager.snapshotBranchDiff(project)).rejects.toBeInstanceOf(NothingToReviewError);
  });

  it('rejects a detached HEAD', async () => {
    if (!gitAvailable) return;
    const { project, workdir } = await setupFixture();
    const sha = (await runGit(['rev-parse', 'HEAD'], { cwd: workdir })).stdout.trim();
    await runGit(['checkout', '-q', sha], { cwd: workdir });
    await expect(manager.snapshotBranchDiff(project)).rejects.toBeInstanceOf(DetachedHeadError);
  });

  it('rejects a branch with nothing beyond the default branch', async () => {
    if (!gitAvailable) return;
    const { project, workdir } = await setupFixture();
    await runGit(['checkout', '-q', '-b', 'feature/empty'], { cwd: workdir });
    await expect(manager.snapshotBranchDiff(project)).rejects.toBeInstanceOf(NothingToReviewError);
  });
});
