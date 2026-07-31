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
