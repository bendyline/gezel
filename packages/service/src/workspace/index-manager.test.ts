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
