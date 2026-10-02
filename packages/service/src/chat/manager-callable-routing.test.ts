import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogService } from '@bendyline/gezel-catalog';
import { describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import type { MemoryManager } from '../memory/manager.js';
import { MockProvider } from '../providers/mock.js';
import { FileSecretStore } from '../secrets/file-store.js';
import { ChatEventBus } from './events.js';
import { ChatManager } from './manager.js';

const noopMemory = {
  save: async () => {},
  search: async () => [],
  searchAll: async () => [],
  reindex: async () => 0,
  writeSummary: async () => {},
  getRecent: async () => '',
} as unknown as MemoryManager;

describe('ChatManager — coordinator routing clamps on a decode-time grammar', () => {
  it('keeps an MLX meester prompt byte-identical when a build request routes the turn', async () => {
    // gemma4-e4b on MLX: the build clamp swapped a 60-tool roster for the
    // 30-tool router surface, rewrote the prompt at token 1,126, and the
    // sliding-window cache — which cannot trim — re-prefilled all 6,420
    // tokens. With a decode-time grammar the clamp narrows what is callable.
    const home = await mkdtemp(join(tmpdir(), 'gezel-mlx-meester-callable-'));
    const localStore = new Store({ home });
    await localStore.ensureLayout();
    await localStore.createGezel({ name: 'Mira', role: 'Meester' });
    await localStore.writeConfig({
      meesterGezelId: 'mira',
      provider: 'mlx',
      defaultModel: { mlx: 'gemma4-e4b-q4' },
    });
    const localMock = new MockProvider({ name: 'mlx' });
    const localMgr = new ChatManager({
      store: localStore,
      events: new ChatEventBus(),
      memory: noopMemory,
      getPort: () => 0,
      getToken: () => 'test-token',
      home,
      providers: [['mlx', localMock]],
      catalog: new CatalogService(),
      secrets: new FileSecretStore(home),
    });
    try {
      const session = await localMgr.createSession({ gezelId: 'mira', projectId: 'default' });
      localMock.script('Happy to help.');
      await localMgr.send(session.id, 'What should we tackle first today?');
      localMock.script('Project is starting.');
      await localMgr.send(session.id, 'Can we build a tank combat game?');

      const [ordinary, routed] = localMock.calls.filter((c) => c.kind === 'create');
      expect(routed).toBeDefined();
      expect(routed!.opts!.systemMessage).toBe(ordinary!.opts!.systemMessage);
      expect(routed!.opts!.toolAllowlist).toEqual(ordinary!.opts!.toolAllowlist);
      expect(ordinary!.opts!.toolAllowlist!.has('write_artifact')).toBe(true);

      expect(ordinary!.opts!.callableToolRestriction).toBeUndefined();
      const restriction = routed!.opts!.callableToolRestriction!;
      expect(restriction.builtins.has('start_project')).toBe(true);
      expect(restriction.builtins.has('write_artifact')).toBe(false);
      expect(restriction.thirdParty).toBe(true);
    } finally {
      await localMgr.drainBackground();
      await localMgr.shutdown();
      await rm(home, { recursive: true, force: true });
    }
  });
});
