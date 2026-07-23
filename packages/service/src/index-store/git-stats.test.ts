import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isGitInstalled, runGit } from '../github/git.js';
import {
  GIT_META_COMMITS,
  GIT_META_LAST_COMMIT,
  gitStatsAvailable,
  parseGitLogNameOnly,
  refreshGitStats,
  resetGitProbeForTests,
} from './git-stats.js';
import { IndexStore } from './index-store.js';

const SOH = '\x01';
const gitOk = await isGitInstalled();

describe('parseGitLogNameOnly', () => {
  it('counts window commits and takes the newest sighting as last-commit', () => {
    const stdout = [
      `${SOH}2000`, // newest
      'a.ts',
      'b.ts',
      '',
      `${SOH}1000`,
      'a.ts',
      '',
      `${SOH}10`, // outside window
      'a.ts',
      'old.ts',
    ].join('\n');
    const stats = parseGitLogNameOnly(stdout, 500 * 1000);
    expect(stats.get('a.ts')).toEqual({ commitsInWindow: 2, lastCommitAtMs: 2000 * 1000 });
    expect(stats.get('b.ts')).toEqual({ commitsInWindow: 1, lastCommitAtMs: 2000 * 1000 });
    expect(stats.get('old.ts')).toEqual({ commitsInWindow: 0, lastCommitAtMs: 10 * 1000 });
  });

  it('is CRLF-safe, skips quoted paths, and tolerates merge-style empty records', () => {
    const stdout = [`${SOH}2000`, '', `${SOH}1000`, '"we\\303\\257rd.ts"', 'ok.ts', ''].join(
      '\r\n',
    );
    const stats = parseGitLogNameOnly(stdout, 0);
    expect(stats.size).toBe(1);
    expect(stats.get('ok.ts')?.commitsInWindow).toBe(1);
  });

  it('skips records with an unparseable timestamp', () => {
    const stats = parseGitLogNameOnly([`${SOH}nope`, 'a.ts'].join('\n'), 0);
    expect(stats.size).toBe(0);
  });
});

describe('refreshGitStats', () => {
  let dir: string;

  beforeEach(async () => {
    resetGitProbeForTests();
    dir = await mkdtemp(join(tmpdir(), 'gezel-gitstats-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  async function openStore(sub = 'ws'): Promise<IndexStore> {
    const store = await IndexStore.open(join(dir, `${sub}-index.db`), {
      collectionId: 'proj-1',
      kind: 'workspace',
      rootPath: join(dir, sub),
    });
    expect(store).not.toBeNull();
    return store as IndexStore;
  }

  function trackFile(store: IndexStore, path: string): void {
    store.upsertFile({
      path,
      hash: `h-${path}`,
      size: 10,
      mtimeMs: 1,
      lang: 'ts',
      kind: 'code',
      modality: 'code',
      trivial: false,
      indexedAt: '2026-01-01T00:00:00Z',
      loc: 5,
    });
  }

  async function commitFile(ws: string, rel: string, content: string, isoDate: string) {
    await writeFile(join(ws, rel), content);
    await runGit(['add', '-A'], { cwd: ws });
    await runGit(['commit', '-m', `touch ${rel}`, '-q'], {
      cwd: ws,
      env: { GIT_AUTHOR_DATE: isoDate, GIT_COMMITTER_DATE: isoDate },
    });
  }

  async function initRepo(ws: string): Promise<void> {
    await mkdir(ws, { recursive: true });
    await runGit(['init', '-q'], { cwd: ws });
    await runGit(['config', 'user.email', 'test@example.com'], { cwd: ws });
    await runGit(['config', 'user.name', 'Test'], { cwd: ws });
  }

  it('marks a non-repo workspace unavailable without throwing', async () => {
    const ws = join(dir, 'plain');
    await mkdir(ws, { recursive: true });
    const store = await openStore('plain');
    const res = await refreshGitStats(store, ws);
    // 'unavailable' either because git is missing or because ws isn't a repo.
    expect(res.state).toBe('unavailable');
    expect(gitStatsAvailable(store)).toBe(false);
    store.close();
  });

  it.skipIf(!gitOk)('ingests churn + last-commit, windowed, for indexed files only', async () => {
    const ws = join(dir, 'ws');
    await initRepo(ws);
    const now = Date.parse('2026-07-01T00:00:00Z');
    await commitFile(ws, 'b.ts', 'old', '2024-06-01T00:00:00Z'); // > 1y old
    await commitFile(ws, 'a.ts', 'v1', '2026-05-01T00:00:00Z');
    await commitFile(ws, 'a.ts', 'v2', '2026-06-01T00:00:00Z');
    await commitFile(ws, 'untracked-by-index.ts', 'x', '2026-06-02T00:00:00Z');

    const store = await openStore();
    trackFile(store, 'a.ts');
    trackFile(store, 'b.ts');
    const res = await refreshGitStats(store, ws, { now: () => now });
    expect(res).toEqual({ state: 'ok', files: 2 });
    expect(gitStatsAvailable(store)).toBe(true);

    const meta = store.metadataValuesForKeys([GIT_META_COMMITS, GIT_META_LAST_COMMIT]);
    expect(meta.get('a.ts')?.[GIT_META_COMMITS]).toBe('2');
    expect(meta.get('a.ts')?.[GIT_META_LAST_COMMIT]).toBe('2026-06-01T00:00:00.000Z');
    // Outside the window but still carries a real last-commit for the lens.
    expect(meta.get('b.ts')?.[GIT_META_COMMITS]).toBe('0');
    expect(meta.get('b.ts')?.[GIT_META_LAST_COMMIT]).toBe('2024-06-01T00:00:00.000Z');
    expect(meta.has('untracked-by-index.ts')).toBe(false);
    store.close();
  });

  it.skipIf(!gitOk)(
    'is fresh on unchanged HEAD within TTL, re-ingests past TTL or on new commits',
    async () => {
      const ws = join(dir, 'ws');
      await initRepo(ws);
      await commitFile(ws, 'a.ts', 'v1', '2026-06-01T00:00:00Z');
      const store = await openStore();
      trackFile(store, 'a.ts');

      const t0 = Date.parse('2026-07-01T00:00:00Z');
      expect((await refreshGitStats(store, ws, { now: () => t0 })).state).toBe('ok');
      expect((await refreshGitStats(store, ws, { now: () => t0 + 1000 })).state).toBe('fresh');
      // Past the TTL the window has drifted → re-ingest despite same HEAD.
      expect((await refreshGitStats(store, ws, { now: () => t0 + 25 * 3600 * 1000 })).state).toBe(
        'ok',
      );
      // A new commit changes HEAD → re-ingest.
      await commitFile(ws, 'a.ts', 'v2', '2026-06-20T00:00:00Z');
      const res = await refreshGitStats(store, ws, { now: () => t0 + 26 * 3600 * 1000 });
      expect(res.state).toBe('ok');
      expect(store.metadataValuesForKeys([GIT_META_COMMITS]).get('a.ts')?.[GIT_META_COMMITS]).toBe(
        '2',
      );
      store.close();
    },
  );

  it.skipIf(!gitOk)('reports paths relative to a subdirectory workspace', async () => {
    const repo = join(dir, 'repo');
    await initRepo(repo);
    await mkdir(join(repo, 'pkg'), { recursive: true });
    await commitFile(repo, join('pkg', 'inner.ts'), 'x', '2026-06-01T00:00:00Z');
    await commitFile(repo, 'outer.ts', 'y', '2026-06-02T00:00:00Z');

    const store = await openStore();
    trackFile(store, 'inner.ts');
    trackFile(store, 'outer.ts');
    const res = await refreshGitStats(store, join(repo, 'pkg'), {
      now: () => Date.parse('2026-07-01T00:00:00Z'),
    });
    expect(res.state).toBe('ok');
    const meta = store.metadataValuesForKeys([GIT_META_COMMITS]);
    // pkg-relative path, and the out-of-subtree file never appears.
    expect(meta.get('inner.ts')?.[GIT_META_COMMITS]).toBe('1');
    expect(meta.has('outer.ts')).toBe(false);
    store.close();
  });

  it.skipIf(!gitOk)('treats an empty repo as unavailable', async () => {
    const ws = join(dir, 'empty');
    await initRepo(ws);
    const store = await openStore('empty');
    expect((await refreshGitStats(store, ws)).state).toBe('unavailable');
    store.close();
  });
});
