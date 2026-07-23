import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../fs/store.js';
import { WorkspaceWatchManager } from './watch-manager.js';

// fs.watch({recursive}) is unavailable on Linux on our pinned Node — the
// manager latches off there, so the behavioral assertions only run where the
// platform supports it.
const RECURSIVE_WATCH = process.platform === 'darwin' || process.platform === 'win32';

let home: string;
let store: Store;
let manager: WorkspaceWatchManager | null = null;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-watch-'));
  store = new Store({ home });
});

afterEach(async () => {
  manager?.stop();
  manager = null;
  await rm(home, { recursive: true, force: true });
});

async function waitFor(cond: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('WorkspaceWatchManager', () => {
  it('watches MRU-top projects and refreshes on a workspace write', async () => {
    if (!RECURSIVE_WATCH) return;
    const project = await store.createProject({ name: 'Watched' });
    const dir = await store.projectWorkspaceDir(project.id);
    await mkdir(dir, { recursive: true });
    await store.writeConfig({
      recentTabs: [{ kind: 'project', id: project.id, at: Date.now(), order: 0 }],
    });

    const refresh = vi.fn(async () => ({}) as never);
    manager = new WorkspaceWatchManager({
      store,
      indexManager: { refresh },
      debounceMs: 100,
    });
    await manager.reconcile();
    expect(manager.watched()).toEqual([project.id]);

    await writeFile(join(dir, 'note.md'), '# hallo\n');
    await waitFor(() => refresh.mock.calls.length > 0);
    expect(refresh).toHaveBeenCalledWith(project.id);
  });

  it('ignores churn in skip dirs and drops watchers for projects leaving the MRU', async () => {
    if (!RECURSIVE_WATCH) return;
    const project = await store.createProject({ name: 'Skippy' });
    const dir = await store.projectWorkspaceDir(project.id);
    await mkdir(join(dir, '.gezel'), { recursive: true });
    await store.writeConfig({
      recentTabs: [{ kind: 'project', id: project.id, at: Date.now(), order: 0 }],
    });

    const refresh = vi.fn(async () => ({}) as never);
    manager = new WorkspaceWatchManager({
      store,
      indexManager: { refresh },
      debounceMs: 50,
    });
    await manager.reconcile();
    // FSEvents can replay pre-watch filesystem history (sometimes with a null
    // filename) right after the watch starts — let that drain, then baseline.
    await new Promise((r) => setTimeout(r, 500));
    const baseline = refresh.mock.calls.length;

    await writeFile(join(dir, '.gezel', 'index-scratch.txt'), 'x');
    await new Promise((r) => setTimeout(r, 400));
    expect(refresh.mock.calls.length).toBe(baseline);

    await store.writeConfig({ recentTabs: [] });
    await manager.reconcile();
    expect(manager.watched()).toEqual([]);
  });
});
