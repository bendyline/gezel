import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CURRENT_DATE_TIME_PREFIX, stripCurrentDateTimeLine } from '@bendyline/gezel';
import { CatalogService } from '@bendyline/gezel-catalog';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../fs/store.js';
import { HistoryManager } from '../history/manager.js';
import type { MemoryManager } from '../memory/manager.js';
import { PreviewLogBuffer } from '../preview-log/buffer.js';
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
let previewLog: PreviewLogBuffer;
let builtBytes: number;
const key = 'llama-cpp:worker-8b:0';
const otherKey = 'llama-cpp:other-27b:0';

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
  builtBytes = 1e9;
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
    return { provider, residentBytes: builtBytes };
  };
  const broker = new CapacityBroker({ budgetBytes: 2e9 });
  const builders = { 'llama-cpp': builder };
  // A short default drain, so a wait that outlives it is visibly unbounded.
  const pool = new ProviderPool({ broker, builders, drainWaitMs: 200 });
  router = new EngineRouter({ broker, pool, builders, resolveResidentBytes: () => 1e9 });
  events = new ChatEventBus();
  previewLog = new PreviewLogBuffer();
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
    previewLog,
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
    const sent = requests[1]?.messages.filter((m) => m.role !== 'system') ?? [];
    expect(sent.at(-1)?.content.startsWith(CURRENT_DATE_TIME_PREFIX)).toBe(true);
    // The rebuilt history replays turn 1 exactly as it was sent, date line
    // included; one byte shorter and the engine's saved prefix stops matching
    // at the first user turn, so the whole transcript is prefilled again.
    const firstSent = requests[0]?.messages.find((m) => m.role === 'user');
    expect(firstSent?.content.startsWith(CURRENT_DATE_TIME_PREFIX)).toBe(true);
    expect(sent[0]).toEqual(firstSent);
    // On disk too, so a daemon restart replays it; the person's words stay clean.
    const saved = await store.findSessionById(record.id);
    expect(saved?.messages[0]?.content).toBe('First review');
    expect(`${saved?.messages[0]?.sentPreamble}First review`).toBe(firstSent?.content);
    expect(sent.map((m) => ({ ...m, content: stripCurrentDateTimeLine(m.content) }))).toEqual([
      { role: 'user', content: 'First review' },
      { role: 'assistant', content: 'Review complete.' },
      { role: 'user', content: 'Second review' },
    ]);
  });

  it('replays a turn prelude exactly as sent after a rebuild', async () => {
    const record = await manager.createSession({ gezelId: 'worker' });
    previewLog.record(record.projectId, [
      {
        kind: 'error',
        message: "Failed to execute 'addColorStop' on 'CanvasGradient': '#0ff33'",
        path: 'index.html',
        source: 'workspace',
        at: '2026-07-19T00:00:00.000Z',
      },
    ]);
    await manager.send(record.id, 'How is the game looking?');
    await router.pool.evict(key);
    await router.ensure('llama-cpp', 'worker-8b', 0);
    await manager.send(record.id, 'And now?');

    const firstSent = requests[0]?.messages.find((m) => m.role === 'user');
    expect(firstSent?.content).toContain('[Live preview reported runtime errors');
    // The rebuilt session carries turn 1's preview block as well as its date
    // line; dropping either one voids the saved prefix from turn 1 onward.
    const replayed = requests[1]?.messages.find((m) => m.role === 'user');
    expect(replayed).toEqual(firstSent);
    const saved = await store.findSessionById(record.id);
    expect(saved?.messages[0]?.content).toBe('How is the game looking?');
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
    expect(
      requests[0]?.messages
        .filter((m) => m.role === 'user')
        .map((m) => ({ ...m, content: stripCurrentDateTimeLine(m.content) })),
    ).toEqual([{ role: 'user', content: 'Review this' }]);
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

  it('waits for a turn on another model to finish instead of failing, then swaps', async () => {
    builtBytes = 1.5e9; // only one model fits the budget
    const vendula = await store.createGezel({ name: 'Vendula' });
    const record = await manager.createSession({ gezelId: 'worker' });
    const other = await router.ensure('llama-cpp', 'other-27b', 0);
    const releaseTaskTurn = await other.queue!.acquire({
      lane: 'background',
      gezelId: vendula.id,
      sessionId: 'task-session',
    });
    const labels: string[] = [];
    events.subscribe(record.id, (event) => {
      if (event.type === 'heartbeat' && event.label) labels.push(event.label);
    });

    let settled = false;
    const reply = manager.send(record.id, 'Review this').finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(settled).toBe(false);
    expect(router.pool.isDraining(otherKey)).toBe(true);
    expect(labels).toContain('Waiting for Vendula to finish before switching models');

    releaseTaskTurn();
    await expect(reply).resolves.toMatchObject({ content: 'Review complete.' });
    expect(router.pool.has(otherKey)).toBe(false);
    expect(router.pool.has(key)).toBe(true);
  });

  it('stopping a turn that waits for a swap leaves the other model running', async () => {
    builtBytes = 1.5e9;
    const record = await manager.createSession({ gezelId: 'worker' });
    const other = await router.ensure('llama-cpp', 'other-27b', 0);
    const releaseTaskTurn = await other.queue!.acquire({ lane: 'background' });

    const reply = manager.send(record.id, 'Review this');
    await new Promise((resolve) => setTimeout(resolve, 300));
    await manager.cancelInflight(record.id);

    await expect(reply).rejects.toThrow();
    expect(router.pool.isDraining(otherKey)).toBe(false);
    expect(router.pool.has(otherKey)).toBe(true);
    expect(requests).toHaveLength(0);
    releaseTaskTurn();
  });

  it('a turn on a model another request is waiting to swap out steps aside, then runs', async () => {
    builtBytes = 1.5e9;
    const record = await manager.createSession({ gezelId: 'worker' });
    await manager.send(record.id, 'First review');
    const releaseRunningTurn = await generations[0]!.queue.acquire({ lane: 'background' });
    const swap = router.ensure('llama-cpp', 'other-27b', 0, {
      drainWaitMs: Number.POSITIVE_INFINITY,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(router.pool.isDraining(key)).toBe(true);

    const reply = manager.send(record.id, 'Second review');
    await new Promise((resolve) => setTimeout(resolve, 50));
    releaseRunningTurn();

    // The waiting swap got its model at the turn boundary, before the new turn.
    const swapped = await swap;
    expect(swapped).toBe(generations[1]);
    await expect(reply).resolves.toMatchObject({ content: 'Review complete.' });
    expect(generations).toHaveLength(3);
    expect(requests).toHaveLength(2);
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
