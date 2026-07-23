import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectDetail } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import type { SecretKey, SecretStore, SecretStoreBackend } from '../secrets/types.js';
import { AmbientGithubAuth } from './ambient.js';
import { isGitInstalled, runGit } from './git.js';
import { GitHubManager } from './manager.js';

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
let store: Store;
let secrets: InMemorySecrets;
let manager: GitHubManager;
let scratch: string;
/** Per-test ambient token — keeps tests hermetic on machines signed into gh. */
let ambientGhToken: string | null;

function stubAmbient(env: Record<string, string | undefined> = {}): AmbientGithubAuth {
  return new AmbientGithubAuth({ env, ghToken: async () => ambientGhToken });
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-github-test-'));
  scratch = await mkdtemp(join(tmpdir(), 'gezel-github-scratch-'));
  store = new Store({ home });
  await store.ensureLayout();
  secrets = new InMemorySecrets();
  ambientGhToken = null;
  manager = new GitHubManager(home, store, secrets, stubAmbient());
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(scratch, { recursive: true, force: true });
});

const URL = 'https://github.com/octocat/Hello-World';

async function makeProject(workingDir?: string): Promise<ProjectDetail> {
  const project = await store.createProject({
    name: 'demo',
    ...(workingDir ? { workingDir } : {}),
  });
  await store.updateProject(project.id, { github: { url: URL } });
  const updated = await store.getProject(project.id);
  if (!updated) throw new Error('project not found after update');
  return updated;
}

async function initLocalRepo(dir: string, originUrl: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await runGit(['init', '-q'], { cwd: dir });
  await runGit(['remote', 'add', 'origin', originUrl], { cwd: dir });
}

describe('GitHubManager.resolveCheckout', () => {
  // Phase 2 of the workspace-fs unification: when there's no
  // workingDir, the clone lands at the project's workspace dir (not
  // a sibling `gh/` folder). The clone IS the workspace from the
  // model's perspective — `readFile('package.json')` returns the
  // repo's package.json, no `gh/` or `repo/` subfolder needed.
  it('uses the internal workspace dir when no workingDir is set (no legacy gh/)', async () => {
    const project = await makeProject();
    const r = await manager.resolveCheckout(project);
    expect(r.dir).toBe(join(home, 'projects', project.id, 'workspace'));
    expect(r.exists).toBe(false);
    expect(r.isAtWorkingDir).toBe(false);
  });

  // Backward compatibility: if a project has a pre-Phase-2 `gh/` clone
  // (from before the workspace-direct change), the resolver adopts it
  // so we don't re-clone the same repo into the workspace. The
  // `cleanStaleWorkspaceBootstraps` migration moves these later.
  it('adopts an existing legacy gh/ clone instead of cloning fresh', async () => {
    const project = await makeProject();
    const legacy = join(home, 'projects', project.id, 'gh');
    await initLocalRepo(legacy, URL);
    const r = await manager.resolveCheckout(project);
    expect(r.dir).toBe(legacy);
    expect(r.exists).toBe(true);
    expect(r.originMatches).toBe(true);
  });

  it('uses workingDir/gh when workingDir is not a matching repo', async () => {
    const wd = join(scratch, 'work');
    await mkdir(wd, { recursive: true });
    const project = await makeProject(wd);
    const r = await manager.resolveCheckout(project);
    expect(r.dir).toBe(join(wd, 'gh'));
    expect(r.exists).toBe(false);
    expect(r.isAtWorkingDir).toBe(false);
  });

  it('adopts workingDir as the checkout when its origin matches', async () => {
    if (!(await isGitInstalled())) return;
    const wd = join(scratch, 'work');
    await initLocalRepo(wd, 'git@github.com:octocat/Hello-World.git');
    await writeFile(join(wd, 'README.md'), '# hi\n');
    const project = await makeProject(wd);
    const r = await manager.resolveCheckout(project);
    expect(r.dir).toBe(wd);
    expect(r.exists).toBe(true);
    expect(r.originMatches).toBe(true);
    expect(r.isAtWorkingDir).toBe(true);
  });

  it('does NOT adopt workingDir when its origin points elsewhere', async () => {
    if (!(await isGitInstalled())) return;
    const wd = join(scratch, 'work');
    await initLocalRepo(wd, 'https://github.com/other/repo.git');
    const project = await makeProject(wd);
    const r = await manager.resolveCheckout(project);
    expect(r.dir).toBe(join(wd, 'gh'));
    expect(r.isAtWorkingDir).toBe(false);
  });
});

describe('GitHubManager status + credentials', () => {
  it('reports hasPat=false and credentialSource=none with no credentials anywhere', async () => {
    const project = await makeProject();
    const status = await manager.status(project);
    expect(status.hasPat).toBe(false);
    expect(status.credentialSource).toBe('none');
  });

  it('reports hasPat=true once the github toolset PAT is set', async () => {
    await secrets.set({ kind: 'toolset', toolsetId: 'github', fieldId: 'token' }, 'ghp_x');
    const project = await makeProject();
    const status = await manager.status(project);
    expect(status.hasPat).toBe(true);
    expect(status.credentialSource).toBe('pat');
  });

  it('reports credentialSource=gh when only the GitHub CLI is signed in', async () => {
    ambientGhToken = 'gho_cli';
    const project = await makeProject();
    const status = await manager.status(project);
    expect(status.hasPat).toBe(false);
    expect(status.credentialSource).toBe('gh');
  });

  it('reports credentialSource=env when GH_TOKEN is set', async () => {
    const withEnv = new GitHubManager(home, store, secrets, stubAmbient({ GH_TOKEN: 'gho_env' }));
    const project = await makeProject();
    const status = await withEnv.status(project);
    expect(status.credentialSource).toBe('env');
  });

  it('returns exists=false for an unconfigured project', async () => {
    const project = await store.createProject({ name: 'no-link' });
    const status = await manager.status((await store.getProject(project.id)) as ProjectDetail);
    expect(status.exists).toBe(false);
    expect(status.github).toBeUndefined();
  });
});

describe('GitHubManager.getToken', () => {
  it('returns null when nothing is configured', async () => {
    expect(await manager.getToken()).toBeNull();
  });

  it('falls back to the gh CLI token when no PAT is stored', async () => {
    ambientGhToken = 'gho_cli';
    expect(await manager.getToken()).toBe('gho_cli');
  });

  it('prefers the stored PAT over ambient credentials', async () => {
    ambientGhToken = 'gho_cli';
    await secrets.set({ kind: 'toolset', toolsetId: 'github', fieldId: 'token' }, 'ghp_stored');
    expect(await manager.getToken()).toBe('ghp_stored');
  });
});

// Phase 3 — shared bare clone + worktree integration. Two projects
// pointing at the same github URL get independent worktrees off a
// single bare clone, saving disk and unlocking the "PR review +
// main branch in parallel" workflow.
//
// These tests use a LOCAL bare repo created with `git init --bare` as
// the upstream — no network involved. The `URL` constant from the
// outer scope points at github.com which we never actually contact.
describe('GitHubManager — shared clones + worktrees (Phase 3)', () => {
  // Set up a small upstream repo with one commit so worktree add has
  // a real ref to check out. Skipped when git is unavailable so CI
  // hosts without git still get the rest of the suite green.
  let upstream: string;
  let upstreamUrl: string;
  let gitAvailable = true;

  beforeEach(async () => {
    gitAvailable = await isGitInstalled();
    if (!gitAvailable) return;
    upstream = join(scratch, 'upstream.git');
    await mkdir(upstream, { recursive: true });
    await runGit(['init', '--bare', '-q'], { cwd: upstream });
    upstreamUrl = upstream;
    // Seed one commit so `worktree add` has something to check out.
    const seed = join(scratch, 'seed');
    await mkdir(seed, { recursive: true });
    await runGit(['init', '-q'], { cwd: seed });
    await runGit(['config', 'user.email', 'test@example.com'], { cwd: seed });
    await runGit(['config', 'user.name', 'Test'], { cwd: seed });
    await writeFile(join(seed, 'README.md'), '# upstream\n', 'utf8');
    await runGit(['add', '.'], { cwd: seed });
    await runGit(['commit', '-m', 'init', '-q'], { cwd: seed });
    await runGit(['branch', '-M', 'main'], { cwd: seed });
    await runGit(['remote', 'add', 'origin', upstream], { cwd: seed });
    await runGit(['push', '-u', 'origin', 'main', '-q'], { cwd: seed });
    // Add a second branch so we have something to worktree onto for
    // the "two projects, same repo" tests — git refuses to check out
    // the same branch in two worktrees simultaneously.
    await runGit(['checkout', '-b', 'feature', '-q'], { cwd: seed });
    await writeFile(join(seed, 'feature.txt'), 'feature branch\n', 'utf8');
    await runGit(['add', '.'], { cwd: seed });
    await runGit(['commit', '-m', 'feature', '-q'], { cwd: seed });
    await runGit(['push', '-u', 'origin', 'feature', '-q'], { cwd: seed });
  });

  it('ensureSharedClone is idempotent for the same URL', async () => {
    if (!gitAvailable) return;
    const first = await manager.ensureSharedClone(upstreamUrl);
    const second = await manager.ensureSharedClone(upstreamUrl);
    expect(first).toBe(second);
    // Confirm it's actually a bare repo.
    const r = await runGit(['rev-parse', '--is-bare-repository'], { cwd: first });
    expect(r.stdout.trim()).toBe('true');
  });

  it('two projects on the same URL share one bare clone with independent worktrees', async () => {
    if (!gitAvailable) return;
    // Pass github at creation so the workspace skips bootstrap seeding
    // (matches the real-world flow that calls addProjectWorktree).
    // Two worktrees can't share a branch (git's safety) — use main +
    // feature so each project has its own checked-out HEAD.
    const pa = await store.createProject({ name: 'A', github: { url: upstreamUrl } });
    const pb = await store.createProject({ name: 'B', github: { url: upstreamUrl } });
    const wtA = await manager.addProjectWorktree({
      projectId: pa.id,
      url: upstreamUrl,
      ref: 'main',
    });
    const wtB = await manager.addProjectWorktree({
      projectId: pb.id,
      url: upstreamUrl,
      ref: 'feature',
    });
    expect(wtA).not.toBe(wtB);
    // Both worktrees see the upstream README — same source, different
    // working trees. Normalize CRLF→LF because git for Windows applies
    // core.autocrlf on worktree checkout; the test cares about content,
    // not platform line endings.
    const { readFile: readF } = await import('node:fs/promises');
    const lf = (s: string) => s.replace(/\r\n/g, '\n');
    expect(lf(await readF(join(wtA, 'README.md'), 'utf8'))).toBe('# upstream\n');
    expect(lf(await readF(join(wtB, 'README.md'), 'utf8'))).toBe('# upstream\n');
    // Branch B (feature) has a file branch A (main) doesn't — proves
    // the worktrees are on different refs.
    const { existsSync } = await import('node:fs');
    expect(existsSync(join(wtA, 'feature.txt'))).toBe(false);
    expect(existsSync(join(wtB, 'feature.txt'))).toBe(true);
    // Writing in A doesn't leak to B.
    await writeFile(join(wtA, 'a-only.txt'), 'A wrote this\n', 'utf8');
    expect(existsSync(join(wtB, 'a-only.txt'))).toBe(false);
  });

  it('removeProjectWorktree deletes only the worktree until the last reference', async () => {
    if (!gitAvailable) return;
    const pa = await store.createProject({ name: 'AA', github: { url: upstreamUrl } });
    const pb = await store.createProject({ name: 'BB', github: { url: upstreamUrl } });
    await manager.addProjectWorktree({ projectId: pa.id, url: upstreamUrl, ref: 'main' });
    await manager.addProjectWorktree({ projectId: pb.id, url: upstreamUrl, ref: 'feature' });
    const key = (await import('./url.js')).sharedCloneKey(upstreamUrl);
    if (!key) throw new Error('expected non-null shared clone key');
    const { sharedCloneDir } = await import('@bendyline/gezel/paths');
    const bareDir = sharedCloneDir(home, key);
    const { existsSync } = await import('node:fs');
    expect(existsSync(bareDir)).toBe(true);

    // Remove A — bare should still exist, B's worktree should still work.
    await manager.removeProjectWorktree({ projectId: pa.id, url: upstreamUrl });
    expect(existsSync(bareDir)).toBe(true);

    // Remove B — last reference; bare gets cleaned up.
    await manager.removeProjectWorktree({ projectId: pb.id, url: upstreamUrl });
    expect(existsSync(bareDir)).toBe(false);
  });

  it('garbageCollectSharedClones removes orphans not referenced by any project', async () => {
    if (!gitAvailable) return;
    // Create a shared clone for a project, then delete the project
    // metadata (simulate manual cleanup) and run GC.
    const p = await store.createProject({ name: 'Orphan' });
    await store.updateProject(p.id, { github: { url: upstreamUrl } });
    await manager.ensureSharedClone(upstreamUrl);
    const key = (await import('./url.js')).sharedCloneKey(upstreamUrl);
    if (!key) throw new Error('expected non-null shared clone key');
    const { sharedCloneDir } = await import('@bendyline/gezel/paths');
    const bareDir = sharedCloneDir(home, key);
    const { existsSync } = await import('node:fs');
    expect(existsSync(bareDir)).toBe(true);

    // Unlink — project no longer references the URL.
    await store.updateProject(p.id, { github: null });

    const result = await manager.garbageCollectSharedClones();
    expect(result.removed).toBe(1);
    expect(existsSync(bareDir)).toBe(false);
  });

  it('garbageCollectSharedClones keeps bares that ARE referenced', async () => {
    if (!gitAvailable) return;
    const p = await store.createProject({ name: 'Referenced' });
    await store.updateProject(p.id, { github: { url: upstreamUrl } });
    await manager.ensureSharedClone(upstreamUrl);
    const result = await manager.garbageCollectSharedClones();
    expect(result.removed).toBe(0);
    expect(result.kept).toBe(1);
  });
});
