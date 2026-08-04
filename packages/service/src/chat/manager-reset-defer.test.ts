import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogService } from '@bendyline/gezel-catalog';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

let home: string;
let store: Store;
let events: ChatEventBus;
let manager: ChatManager;
let mock: MockProvider;

const waitFor = async (pred: () => boolean, timeoutMs = 2000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitFor: condition not met in time');
    await new Promise<void>((r) => setTimeout(r, 5));
  }
};

const disconnects = (sessionId: string) =>
  mock.calls.filter((c) => c.kind === 'disconnect' && c.sessionId === sessionId).length;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-reset-defer-'));
  store = new Store({ home });
  await store.ensureLayout();
  mock = new MockProvider({ name: 'openai' });
  await store.writeConfig({ provider: 'openai' });
  events = new ChatEventBus();
  manager = new ChatManager({
    store,
    events,
    memory: noopMemory,
    getPort: () => 0,
    getToken: () => 'test-token',
    home,
    providers: [['openai', mock]],
    catalog: new CatalogService(),
    secrets: new FileSecretStore(home),
  });
});

afterEach(async () => {
  await manager.drainBackground();
  await manager.shutdown();
  await rm(home, { recursive: true, force: true });
});

describe('ChatManager.resetClient — deferred (model-preference) reset', () => {
  it('keeps an injected provider authoritative across a hard reset', async () => {
    await store.createGezel({ name: 'Mina', role: 'Builder' });
    const session = await manager.createSession({ gezelId: 'mina' });

    await manager.send(session.id, 'before reset');
    await manager.resetClient();

    expect(manager.getProviderIfReady('openai')).toBe(mock);
    await manager.send(session.id, 'after reset');

    const record = await store.getSession('mina', session.id);
    expect(record?.messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: 'Mock reply: after reset',
    });
  });

  it('does not sever a session that is mid-turn; tears it down once idle', async () => {
    // Mirrors the production bug: a video-generation turn (an in-flight
    // `generate_video` MCP call) was killed when the user changed their
    // default chat model, because resetClient disconnected every session
    // unconditionally. A deferred reset must leave the running turn alone.
    await store.createGezel({ name: 'Dayeon', role: 'Video generator' });
    const session = await manager.createSession({ gezelId: 'dayeon' });
    mock.script('done');
    mock.scriptSendDelay(250); // keep the turn in-flight across the reset

    const sendPromise = manager.send(session.id, 'make a video');

    // Wait until the turn is actually running on the provider.
    await waitFor(() => mock.calls.some((c) => c.kind === 'send'));
    const liveSessionId = mock.calls.find((c) => c.kind === 'send')?.sessionId ?? '';
    expect(liveSessionId).not.toBe('');

    const before = disconnects(liveSessionId);
    await manager.resetClient({ deferBusy: true });
    // The mid-turn session must NOT have been disconnected.
    expect(disconnects(liveSessionId)).toBe(before);

    await sendPromise;

    // Now idle, the deferred teardown fires so the next turn rebuilds
    // against the new default model.
    await waitFor(() => disconnects(liveSessionId) > before);
  });

  it('tears an idle session down immediately on a deferred reset', async () => {
    await store.createGezel({ name: 'Ivy', role: 'Builder' });
    const session = await manager.createSession({ gezelId: 'ivy' });
    // A completed turn builds (and leaves live) the provider session.
    mock.script('hello');
    await manager.send(session.id, 'hi');
    const liveSessionId = mock.calls.find((c) => c.kind === 'send')?.sessionId ?? '';
    expect(liveSessionId).not.toBe('');

    const before = disconnects(liveSessionId);
    await manager.resetClient({ deferBusy: true });

    // Idle → no deferral; the session is torn down right away so the next
    // turn rebuilds against the new default.
    expect(disconnects(liveSessionId)).toBeGreaterThan(before);
  });

  it('broker retirement waits for a queue-bypassing local turn and registers one teardown', async () => {
    await manager.shutdown();
    mock = new MockProvider({ name: 'llama-cpp' });
    await store.writeConfig({
      provider: 'llama-cpp',
      defaultModel: { 'llama-cpp': 'mock-local' },
    });
    manager = new ChatManager({
      store,
      events,
      memory: noopMemory,
      getPort: () => 0,
      getToken: () => 'test-token',
      home,
      providers: [['llama-cpp', mock]],
      catalog: new CatalogService(),
      secrets: new FileSecretStore(home),
    });
    await store.createGezel({ name: 'Nia', role: 'Builder' });
    const session = await manager.createSession({ gezelId: 'nia' });
    mock.script('finished locally');
    mock.scriptSendDelay(250);

    const send = manager.send(session.id, 'long local turn');
    await waitFor(() => mock.calls.some((call) => call.kind === 'send'));
    const liveSessionId = mock.calls.find((call) => call.kind === 'send')?.sessionId ?? '';

    const firstRetirement = manager.retireLocalEnginesForMachineBroker();
    const joinedRetirement = manager.retireLocalEnginesForMachineBroker();
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    expect(disconnects(liveSessionId)).toBe(0);

    await send;
    await Promise.all([firstRetirement, joinedRetirement]);
    expect(disconnects(liveSessionId)).toBe(1);
  });
});
