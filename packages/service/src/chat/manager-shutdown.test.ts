import { describe, expect, it, vi } from 'vitest';
import { ChatEventBus } from './events.js';
import { ChatManager } from './manager.js';

type EngineRouter = import('../providers/native/engine-router.js').EngineRouter;

function makeManager(engineRouter?: EngineRouter): ChatManager {
  return new ChatManager({
    store: { readConfig: async () => ({}) } as never,
    events: new ChatEventBus(),
    memory: {} as never,
    getPort: () => 0,
    getToken: () => 'test-token',
    home: '/tmp/gezel-manager-shutdown-test',
    catalog: {} as never,
    secrets: {} as never,
    ...(engineRouter ? { engineRouter } : {}),
  });
}

function ownedRouter() {
  return {
    shutdown: vi.fn(async () => {}),
  } as unknown as EngineRouter;
}

describe('ChatManager pooled-engine shutdown', () => {
  it('shuts down the production-owned lazy engine router', async () => {
    const manager = makeManager();
    const router = ownedRouter();
    (
      manager as unknown as {
        engineRouterCache: EngineRouter | null;
      }
    ).engineRouterCache = router;

    await manager.shutdown();

    expect(router.shutdown).toHaveBeenCalledOnce();
  });

  it('awaits an in-flight router construction before shutting it down', async () => {
    const manager = makeManager();
    const router = ownedRouter();
    let finishBuild!: (router: EngineRouter) => void;
    const pending = new Promise<EngineRouter>((resolve) => {
      finishBuild = resolve;
    });
    (
      manager as unknown as {
        engineRouterInitPromise: Promise<EngineRouter | null> | null;
      }
    ).engineRouterInitPromise = pending;

    const stopping = manager.shutdown();
    await Promise.resolve();
    expect(router.shutdown).not.toHaveBeenCalled();

    finishBuild(router);
    await stopping;

    expect(router.shutdown).toHaveBeenCalledOnce();
  });

  it('does not dispose an explicitly injected caller-owned router', async () => {
    const router = ownedRouter();
    const manager = makeManager(router);

    await manager.shutdown();

    expect(router.shutdown).not.toHaveBeenCalled();
  });

  it('awaits tracked background work before shutting down providers', async () => {
    const provider = {
      initialize: vi.fn(async () => {}),
      shutdown: vi.fn(async () => {}),
    };
    const manager = new ChatManager({
      store: { readConfig: async () => ({}) } as never,
      events: new ChatEventBus(),
      memory: {} as never,
      getPort: () => 0,
      getToken: () => 'test-token',
      home: '/tmp/gezel-manager-shutdown-test',
      catalog: {} as never,
      secrets: {} as never,
      providers: [['copilot', provider as never]],
    });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    manager.trackBackground(pending);

    const stopping = manager.shutdown();
    await Promise.resolve();
    expect(provider.shutdown).not.toHaveBeenCalled();

    release();
    await stopping;

    expect(provider.shutdown).toHaveBeenCalledOnce();
  });

  it('refuses to construct a provider after shutdown', async () => {
    const manager = makeManager();
    await manager.shutdown();

    await expect(manager.getProvider('copilot')).rejects.toThrow(
      'Chat manager is shutting down; refusing to initialize provider "copilot"',
    );
  });

  it('tracks rejected background work without emitting a detached rejection', async () => {
    const manager = makeManager();
    manager.trackBackground(Promise.reject(new Error('expected background failure')));

    await manager.drainBackground();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await manager.shutdown();
  });
});
