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

function ownedRouter(busyKeys: string[] = []) {
  return {
    shutdown: vi.fn(async () => {}),
    releaseIdle: vi.fn(async () => busyKeys),
  } as unknown as EngineRouter;
}

function cacheRouter(manager: ChatManager, router: EngineRouter): void {
  (
    manager as unknown as {
      engineRouterCache: EngineRouter | null;
    }
  ).engineRouterCache = router;
}

function cachedRouter(manager: ChatManager): EngineRouter | null {
  return (
    manager as unknown as {
      engineRouterCache: EngineRouter | null;
    }
  ).engineRouterCache;
}

describe('ChatManager pooled-engine shutdown', () => {
  it('shuts down the production-owned lazy engine router', async () => {
    const manager = makeManager();
    const router = ownedRouter();
    cacheRouter(manager, router);

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

describe('ChatManager.resetClient — live (config-change) engine handling', () => {
  it('releases idle engines instead of force-killing the pool', async () => {
    const manager = makeManager();
    const router = ownedRouter();
    cacheRouter(manager, router);

    await manager.resetClient();

    expect(router.releaseIdle).toHaveBeenCalledOnce();
    expect(router.shutdown).not.toHaveBeenCalled();
  });

  it('keeps the router so an engine still serving a turn is never orphaned', async () => {
    const manager = makeManager();
    const router = ownedRouter(['mlx:qwen3.8-27b-q4:0']);
    cacheRouter(manager, router);

    await manager.resetClient();

    // Dropping the router while an engine is resident would leave that
    // process outside the broker's accounting with nobody left to evict it.
    expect(cachedRouter(manager)).toBe(router);
  });

  it('still force-evicts when the caller asks for it (emergency stop / shutdown)', async () => {
    const manager = makeManager();
    const router = ownedRouter();
    cacheRouter(manager, router);

    await manager.resetClient({ engines: 'force' });

    expect(router.shutdown).toHaveBeenCalledOnce();
    expect(router.releaseIdle).not.toHaveBeenCalled();
    expect(cachedRouter(manager)).toBeNull();
  });

  it('leaves engines completely alone on a deferred model-preference reset', async () => {
    const manager = makeManager();
    const router = ownedRouter();
    cacheRouter(manager, router);

    await manager.resetClient({ deferBusy: true });

    expect(router.shutdown).not.toHaveBeenCalled();
    expect(router.releaseIdle).not.toHaveBeenCalled();
  });
});
