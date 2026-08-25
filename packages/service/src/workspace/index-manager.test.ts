import { describe, expect, it, vi } from 'vitest';
import type { ChatManager } from '../chat/manager.js';
import type { Store } from '../fs/store.js';
import { WorkspaceIndexManager } from './index-manager.js';

describe('WorkspaceIndexManager project opt-out', () => {
  it('reports disabled and refuses forced refreshes', async () => {
    const projectWorkspaceDir = vi.fn(async () => 'D:\\workspace');
    const store = {
      projectIndexingEnabled: vi.fn(async () => false),
      projectWorkspaceDir,
    } as unknown as Store;
    const manager = new WorkspaceIndexManager({
      home: 'D:\\gezel-home',
      store,
      chat: { isProjectActive: () => false } as unknown as ChatManager,
      catalog: {} as never,
    });

    await expect(manager.status('checkers')).resolves.toEqual({ state: 'disabled' });
    await expect(manager.refresh('checkers')).resolves.toEqual({ state: 'disabled' });
    expect(projectWorkspaceDir).not.toHaveBeenCalled();
  });
});

describe('withLock serialization contract', () => {
  const makeManager = () =>
    new WorkspaceIndexManager({
      home: 'D:\\gezel-home',
      store: {
        projectIndexingEnabled: vi.fn(async () => false),
        projectWorkspaceDir: vi.fn(async () => 'D:\\workspace'),
      } as unknown as Store,
      chat: { isProjectActive: () => false } as unknown as ChatManager,
      catalog: {} as never,
    }) as unknown as {
      withLock<T>(projectId: string, fn: () => Promise<T>): Promise<T>;
      locks: Map<string, Promise<unknown>>;
    };

  const settled = () => new Promise<void>((resolve) => setImmediate(resolve));

  it('releases the map entry after the work settles', async () => {
    const manager = makeManager();
    await expect(manager.withLock('p', async () => 'done')).resolves.toBe('done');
    await settled();
    expect(manager.locks.size).toBe(0);
  });

  it('a rejecting body does not poison subsequent callers', async () => {
    const manager = makeManager();
    await expect(
      manager.withLock('p', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await expect(manager.withLock('p', async () => 'ok')).resolves.toBe('ok');
    await settled();
    expect(manager.locks.size).toBe(0);
  });

  it('serializes concurrent callers on the same project', async () => {
    const manager = makeManager();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = manager.withLock('p', async () => {
      order.push('first-start');
      await gate;
      order.push('first-end');
    });
    const second = manager.withLock('p', async () => {
      order.push('second');
    });
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['first-start', 'first-end', 'second']);
  });
});

describe('statusForUi embeddings health', () => {
  it('attaches semantic-search health in EVERY state, not only fresh', async () => {
    // A dead embedder must be distinguishable from an index that simply
    // hasn't been built yet — so even `never`/`disabled` carry the health.
    const store = {
      projectIndexingEnabled: vi.fn(async () => false),
      projectWorkspaceDir: vi.fn(async () => 'D:\\workspace'),
    } as unknown as Store;
    const manager = new WorkspaceIndexManager({
      home: 'D:\\gezel-home',
      store,
      chat: { isProjectActive: () => false } as unknown as ChatManager,
      catalog: {} as never,
    });

    const status = await manager.statusForUi('checkers');
    expect(status.state).toBe('disabled');
    expect(status.embeddings).toBeDefined();
    expect(['cold', 'warming', 'ready', 'disabled', 'unavailable']).toContain(
      status.embeddings?.status,
    );
  });
});
