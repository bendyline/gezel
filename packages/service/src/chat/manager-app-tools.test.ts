import { mkdtemp, rm } from 'node:fs/promises';
/**
 * ChatManager + app tools. Proves the full loop a connected app depends on:
 * it registers a tool, a gezel calls it, the daemon forwards the call to the
 * app, and the app's answer becomes the tool output the model sees — with the
 * same transcript, event and history trail as any other tool.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppToolRelayEvent, ChatEvent } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppToolRelayRegistry, type AppToolRelayStreamSink } from '../app-tools/relay-registry.js';
import type { Store } from '../fs/store.js';
import type { MemoryManager } from '../memory/manager.js';
import { MockProvider } from '../providers/mock.js';
import { type RunningService, startService } from '../service.js';
import { ChatEventBus } from './events.js';
import { ChatManager } from './manager.js';

const noopMemory = {
  save: async () => {},
  search: async () => [],
  reindex: async () => 0,
  writeSummary: async () => {},
  getRecent: async () => '',
} as unknown as MemoryManager;

const TRAVEL_TOOL = {
  name: 'add_travel_points',
  description: 'Award travel points to the traveller.',
  inputSchema: {
    type: 'object',
    properties: { points: { type: 'number' }, reason: { type: 'string' } },
    required: ['points'],
  },
};

let svc: RunningService;
let home: string;
let store: Store;
let events: ChatEventBus;
let manager: ChatManager;
let mock: MockProvider;
let relays: AppToolRelayRegistry;

/** A connected app that answers every call with `respond`. */
function connectApp(
  respond: (relayId: string, call: Extract<AppToolRelayEvent, { type: 'tool_call' }>) => void,
  opts: { appId?: string; gezelIds?: string[] } = {},
): { relayId: string; seen: Array<Record<string, unknown>> } {
  const seen: Array<Record<string, unknown>> = [];
  const { relayId } = relays.open({ appId: opts.appId ?? 'qualla', appName: 'Qualla' });
  const sink: AppToolRelayStreamSink = {
    write(event) {
      if (event.type !== 'tool_call') return;
      seen.push({ tool: event.tool, args: event.arguments, gezelId: event.gezelId });
      queueMicrotask(() => respond(relayId, event));
    },
  };
  relays.attachStream(relayId, sink);
  relays.register(relayId, {
    projectId: 'default',
    ...(opts.gezelIds ? { gezelIds: opts.gezelIds } : {}),
    tools: [TRAVEL_TOOL],
  });
  return { relayId, seen };
}

beforeEach(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  home = await mkdtemp(join(tmpdir(), 'gezel-app-tools-test-'));
  svc = await startService({ home });
  store = svc.context.store;
  events = new ChatEventBus();
  mock = new MockProvider({ name: 'openai' });
  relays = new AppToolRelayRegistry();
  manager = new ChatManager({
    store,
    events,
    memory: noopMemory,
    getPort: () => svc.port,
    getToken: () => svc.context.token,
    getCert: () => svc.cert?.certPem ?? null,
    home,
    providers: [['openai', mock]],
    catalog: svc.context.catalog,
    secrets: svc.context.secrets,
    history: svc.context.history,
    appToolRelays: relays,
  });
  await store.createGezel({ name: 'Ada', role: 'Developer' });
  await store.writeConfig({ provider: 'openai', toolFilterMode: 'never' });
}, 20_000);

afterEach(async () => {
  await manager?.drainBackground();
  await manager?.shutdown();
  await svc?.stop();
  await rm(home, { recursive: true, force: true }).catch(() => {});
  delete process.env.GEZEL_MOCK_PROVIDER;
});

describe('ChatManager + app tools', () => {
  it('runs a registered tool in the app and returns its answer to the model', async () => {
    const app = connectApp((relayId, call) =>
      relays.resolveCall(relayId, call.callId, {
        ok: true,
        content: `awarded ${(call.arguments as { points: number }).points} points`,
      }),
    );

    const session = await manager.createSession({ gezelId: 'ada' });
    const toolEvents: ChatEvent[] = [];
    events.subscribeAll((env) => {
      if (env.event.type === 'tool') toolEvents.push(env.event);
    });

    mock.scriptToolCalls([
      { name: 'add_travel_points', arguments: { points: 5, reason: 'booked a trip' } },
    ]);
    mock.script('Awarded the points.');
    await manager.send(session.id, 'Give the traveller 5 points for booking.');

    expect(app.seen).toEqual([
      { tool: 'add_travel_points', args: { points: 5, reason: 'booked a trip' }, gezelId: 'ada' },
    ]);
    expect(mock.toolCallOutputs.find(({ name }) => name === 'add_travel_points')?.output).toContain(
      'awarded 5 points',
    );

    // The transcript, the live event stream and the audit log treat it as an
    // ordinary tool call — an app tool is not a second class of tool.
    const persisted = await store.getSession('ada', session.id);
    const reply = persisted?.messages.find(({ content }) => content === 'Awarded the points.');
    expect(reply?.toolCalls?.[0]).toMatchObject({ name: 'add_travel_points', success: true });
    expect(toolEvents.map((e) => (e.type === 'tool' ? e.name : ''))).toContain('add_travel_points');
    const logged = await svc.context.history.listEvents({
      projectId: 'default',
      kinds: ['tool.called'],
    });
    expect(logged.some((entry) => JSON.stringify(entry).includes('add_travel_points'))).toBe(true);
  }, 30_000);

  it('tells the model the call failed when the app reports an error', async () => {
    connectApp((relayId, call) =>
      relays.resolveCall(relayId, call.callId, {
        ok: false,
        error: 'this traveller has no account',
      }),
    );

    const session = await manager.createSession({ gezelId: 'ada' });
    mock.scriptToolCalls([{ name: 'add_travel_points', arguments: { points: 1 } }]);
    mock.script('I could not award the points.');
    await manager.send(session.id, 'Award a point.');

    expect(mock.toolCallOutputs.find(({ name }) => name === 'add_travel_points')?.output).toContain(
      'this traveller has no account',
    );
    const persisted = await store.getSession('ada', session.id);
    const reply = persisted?.messages.find(
      ({ content }) => content === 'I could not award the points.',
    );
    expect(reply?.toolCalls?.[0]).toMatchObject({ name: 'add_travel_points', success: false });
  }, 30_000);

  it('picks up a tool registered after the session was already live', async () => {
    const session = await manager.createSession({ gezelId: 'ada' });
    mock.script('Nothing to do yet.');
    await manager.send(session.id, 'Hello.');
    // Let the turn's background work (titling, extraction) finish first: those
    // one-shots share this provider and would eat the scripted call below.
    await manager.drainBackground();

    connectApp((relayId, call) =>
      relays.resolveCall(relayId, call.callId, { ok: true, content: 'awarded later' }),
    );

    mock.scriptToolCalls([{ name: 'add_travel_points', arguments: { points: 2 } }]);
    mock.script('Awarded.');
    await manager.send(session.id, 'Now award 2 points.');

    expect(mock.toolCallOutputs.find(({ name }) => name === 'add_travel_points')?.output).toContain(
      'awarded later',
    );
  }, 40_000);

  it("withholds an app's tools from gezels it did not name", async () => {
    await store.createGezel({ name: 'Bram', role: 'Developer' });
    connectApp(
      (relayId, call) => relays.resolveCall(relayId, call.callId, { ok: true, content: 'awarded' }),
      { gezelIds: ['ada'] },
    );

    const session = await manager.createSession({ gezelId: 'bram' });
    mock.scriptToolCalls([{ name: 'add_travel_points', arguments: { points: 1 } }]);
    mock.script('That tool is not available to me.');

    // Bram was never offered the tool, so the call cannot resolve to Ada's
    // app. What matters is that it never reaches the app, not how it fails.
    await expect(manager.send(session.id, 'Award a point.')).rejects.toThrow(
      /no bridge has tool "add_travel_points"/,
    );
    expect(mock.toolCallOutputs.find(({ name }) => name === 'add_travel_points')).toBeUndefined();
  }, 30_000);

  it('withholds app tools from a provider that runs its own tool loop', async () => {
    // Copilot and the CLI providers never reach an in-process server, so
    // advertising the tool in their prompt would promise a call they cannot
    // make. Registration is identical; only the provider differs.
    const copilotMock = new MockProvider({ name: 'copilot' });
    const copilotManager = new ChatManager({
      store,
      events,
      memory: noopMemory,
      getPort: () => svc.port,
      getToken: () => svc.context.token,
      getCert: () => svc.cert?.certPem ?? null,
      home,
      providers: [['copilot', copilotMock]],
      catalog: svc.context.catalog,
      secrets: svc.context.secrets,
      history: svc.context.history,
      appToolRelays: relays,
    });
    try {
      await store.writeConfig({ provider: 'copilot', toolFilterMode: 'never' });
      connectApp((relayId, call) =>
        relays.resolveCall(relayId, call.callId, { ok: true, content: 'awarded' }),
      );
      const session = await copilotManager.createSession({ gezelId: 'ada' });
      copilotMock.scriptToolCalls([{ name: 'add_travel_points', arguments: { points: 1 } }]);
      copilotMock.script('No such tool.');

      await expect(copilotManager.send(session.id, 'Award a point.')).rejects.toThrow(
        /no bridge has tool "add_travel_points"/,
      );
    } finally {
      await copilotManager.drainBackground();
      await copilotManager.shutdown();
      await store.writeConfig({ provider: 'openai', toolFilterMode: 'never' });
    }
  }, 30_000);
});
