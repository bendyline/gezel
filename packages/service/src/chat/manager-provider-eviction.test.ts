import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogService } from '@bendyline/gezel-catalog';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../fs/store.js';
import { HistoryManager } from '../history/manager.js';
import type { MemoryManager } from '../memory/manager.js';
import type { LlamaCppModelManager } from '../providers/llama-cpp/index.js';
import { LlamaCppProvider } from '../providers/llama-cpp/provider.js';
import { MockProvider } from '../providers/mock.js';
import { CapacityBroker } from '../providers/native/capacity-broker.js';
import { EngineRouter } from '../providers/native/engine-router.js';
import { type ProviderBuilder, ProviderPool } from '../providers/native/provider-pool.js';
import { ProviderDisposedError } from '../providers/provider-disposal.js';
import type { LLMSession, SessionOpts } from '../providers/types.js';
import { FileSecretStore } from '../secrets/file-store.js';
import { ChatEventBus } from './events.js';
import { ChatManager } from './manager.js';

let home: string;
let store: Store;
let manager: ChatManager;
let router: EngineRouter;
let events: ChatEventBus;
let generations: LlamaCppProvider[];
let requests: Array<{ messages: Array<{ role: string; content: string }> }>;
let sessionOpts: SessionOpts[];
let beforeCreate: (() => Promise<void>) | undefined;
let afterCreate: ((session: LLMSession) => Promise<void>) | undefined;
const key = 'llama-cpp:worker-8b:0';

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-provider-eviction-'));
  const history = new HistoryManager(home);
  store = new Store({ home, history });
  await store.ensureLayout();
  await store.createGezel({ name: 'Worker' });
  await store.writeConfig({ provider: 'llama-cpp', defaultModel: { 'llama-cpp': 'worker-8b' } });
  generations = [];
  requests = [];
  sessionOpts = [];
  beforeCreate = undefined;
  afterCreate = undefined;
  const builder: ProviderBuilder = async () => {
    const provider = new LlamaCppProvider({
      baseUrl: 'http://llama.test',
      fetchImpl: (async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return new Response(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Review complete.' } }] })}\n\ndata: [DONE]\n\n`,
          { headers: { 'Content-Type': 'text/event-stream' } },
        );
      }) as typeof fetch,
    });
    const create = provider.createSession.bind(provider);
    vi.spyOn(provider, 'createSession').mockImplementation(async (opts) => {
      sessionOpts.push(opts);
      await beforeCreate?.();
      const session = await create({
        systemMessage: opts.systemMessage,
        model: opts.model,
        priorMessages: opts.priorMessages,
      });
      await afterCreate?.(session);
      return session;
    });
    generations.push(provider);
    return { provider, residentBytes: 1e9 };
  };
  const broker = new CapacityBroker({ budgetBytes: 2e9 });
  const builders = { 'llama-cpp': builder };
  const pool = new ProviderPool({ broker, builders });
  router = new EngineRouter({ broker, pool, builders, resolveResidentBytes: () => 1e9 });
  events = new ChatEventBus();
  manager = new ChatManager({
    store,
    events,
    history,
    home,
    memory: {
      save: async () => {},
      search: async () => [],
      searchAll: async () => [],
      reindex: async () => 0,
      writeSummary: async () => {},
      getRecent: async () => '',
    } as unknown as MemoryManager,
    getPort: () => 0,
    getToken: () => 'test-token',
    catalog: new CatalogService(),
    secrets: new FileSecretStore(home),
    providers: [['llama-cpp', new MockProvider({ name: 'llama-cpp' })]],
    llamaCppModels: {
      listInstalled: async () => [{ id: 'worker-8b', approxSizeBytes: 1e9 }],
      resolveModel: async () => ({ id: 'worker-8b', approxSizeBytes: 1e9 }),
    } as unknown as LlamaCppModelManager,
    engineRouter: router,
  });
});

afterEach(async () => {
  await manager.drainBackground();
  await manager.shutdown();
  vi.restoreAllMocks();
  await rm(home, { recursive: true, force: true });
});

describe('chat recovery after local engine eviction', () => {
  it('rebinds a cached session after the pool replaces its engine under the same key', async () => {
    const record = await manager.createSession({ gezelId: 'worker' });
    await manager.send(record.id, 'First review');
    await router.pool.evict(key);
    await router.ensure('llama-cpp', 'worker-8b', 0);
    await expect(manager.send(record.id, 'Second review')).resolves.toMatchObject({
      content: 'Review complete.',
    });
    expect(generations).toHaveLength(2);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.messages.filter((m) => m.role !== 'system')).toEqual([
      { role: 'user', content: 'First review' },
      { role: 'assistant', content: 'Review complete.' },
      { role: 'user', content: 'Second review' },
    ]);
  });

  it('re-resolves when eviction happens while session options are being prepared', async () => {
    beforeCreate = async () => {
      beforeCreate = undefined;
      await router.pool.evict(key);
    };
    const record = await manager.createSession({ gezelId: 'worker' });
    await expect(manager.send(record.id, 'Review this')).resolves.toMatchObject({
      content: 'Review complete.',
    });
    expect(generations).toHaveLength(2);
    expect(requests).toHaveLength(1);
  });

  it('retries once when eviction races session creation, without duplicating the user message', async () => {
    afterCreate = async () => {
      afterCreate = undefined;
      await router.pool.evict(key);
    };
    const record = await manager.createSession({ gezelId: 'worker' });
    await expect(manager.send(record.id, 'Review this')).resolves.toMatchObject({
      content: 'Review complete.',
    });
    expect(generations).toHaveLength(2);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.messages.filter((m) => m.role === 'user')).toEqual([
      { role: 'user', content: 'Review this' },
    ]);
    const saved = await store.findSessionById(record.id);
    expect(saved?.messages).toHaveLength(2);
    expect(saved?.resumeFailed).not.toBe(true);
  });

  it('stops after one pre-start retry if the replacement is evicted too', async () => {
    afterCreate = async () => {
      await router.pool.evict(key);
    };
    const record = await manager.createSession({ gezelId: 'worker' });
    await expect(manager.send(record.id, 'Review this')).rejects.toBeInstanceOf(
      ProviderDisposedError,
    );
    expect(generations).toHaveLength(2);
    expect(requests).toHaveLength(0);
  });

  it('bounds recovery when every session preparation loses its provider', async () => {
    beforeCreate = async () => {
      await router.pool.evict(key);
    };
    const record = await manager.createSession({ gezelId: 'worker' });
    await expect(manager.send(record.id, 'Review this')).rejects.toBeInstanceOf(
      ProviderDisposedError,
    );
    expect(generations).toHaveLength(2);
    expect(requests).toHaveLength(0);
  });

  it('does not revive a cancelled turn after eviction during setup', async () => {
    const record = await manager.createSession({ gezelId: 'worker' });
    afterCreate = async () => {
      await router.pool.evict(key);
      await manager.cancelInflight(record.id);
    };
    await expect(manager.send(record.id, 'Review this')).rejects.toThrow();
    expect(generations).toHaveLength(1);
    expect(requests).toHaveLength(0);
  });

  it('does not replay an ordinary mid-turn failure with the same error text', async () => {
    const work = vi.fn();
    afterCreate = async (session) => {
      vi.spyOn(session, 'sendAndWait').mockImplementation(async () => {
        work();
        throw new Error('[llama-cpp] provider disposed (engine was evicted) — re-resolve it');
      });
    };
    const record = await manager.createSession({ gezelId: 'worker' });
    await expect(manager.send(record.id, 'Review this')).rejects.toThrow('provider disposed');
    expect(work).toHaveBeenCalledOnce();
    expect(generations).toHaveLength(1);
  });
});
