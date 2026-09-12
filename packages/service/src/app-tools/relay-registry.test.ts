import type { AppToolRelayEvent } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AppToolRelayError,
  AppToolRelayRegistry,
  type AppToolRelayStreamSink,
} from './relay-registry.js';

function sink(): AppToolRelayStreamSink & { events: AppToolRelayEvent[] } {
  const events: AppToolRelayEvent[] = [];
  return { events, write: (event) => void events.push(event) };
}

const TOOL = {
  name: 'add_travel_points',
  description: 'Award travel points to the traveller.',
  inputSchema: { type: 'object', properties: { points: { type: 'number' } } },
};

function openRegistered(registry: AppToolRelayRegistry, appId = 'qualla') {
  const { relayId } = registry.open({ appId, appName: 'Qualla' });
  const stream = sink();
  const attached = registry.attachStream(relayId, stream);
  registry.register(relayId, { projectId: 'trips', tools: [TOOL] });
  return { relayId, stream, attached };
}

function lastCall(stream: { events: AppToolRelayEvent[] }) {
  const event = [...stream.events].reverse().find((e) => e.type === 'tool_call');
  if (!event || event.type !== 'tool_call') throw new Error('no tool_call emitted');
  return event;
}

describe('AppToolRelayRegistry', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('announces readiness and publishes registered tools to a matching session', () => {
    const registry = new AppToolRelayRegistry();
    const { relayId, stream } = openRegistered(registry);

    expect(stream.events[0]).toMatchObject({ type: 'ready', relayId });
    expect(stream.events[1]).toMatchObject({
      type: 'tools_replaced',
      tools: ['add_travel_points'],
    });

    const bindings = registry.listForSession({ projectId: 'trips', gezelId: 'gids' });
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.tools[0]?.name).toBe('add_travel_points');
    expect(registry.listForSession({ projectId: 'elders', gezelId: 'gids' })).toEqual([]);
  });

  it('limits tools to the named gezels when the app asked for that', () => {
    const registry = new AppToolRelayRegistry();
    const { relayId } = registry.open({ appId: 'qualla' });
    registry.attachStream(relayId, sink());
    registry.register(relayId, { projectId: 'trips', gezelIds: ['gids'], tools: [TOOL] });

    expect(registry.listForSession({ projectId: 'trips', gezelId: 'gids' })).toHaveLength(1);
    expect(registry.listForSession({ projectId: 'trips', gezelId: 'kok' })).toEqual([]);
  });

  it('round-trips a call from the stream back to the caller', async () => {
    const registry = new AppToolRelayRegistry();
    const { relayId, stream } = openRegistered(registry);
    const binding = registry.listForSession({ projectId: 'trips', gezelId: 'gids' })[0];
    if (!binding) throw new Error('no binding');

    const pending = registry.invoke(binding, {
      tool: 'add_travel_points',
      args: { points: 5 },
      sessionId: 's1',
      gezelId: 'gids',
      projectId: 'trips',
    });
    const call = lastCall(stream);
    expect(call).toMatchObject({ tool: 'add_travel_points', arguments: { points: 5 } });

    expect(registry.resolveCall(relayId, call.callId, { ok: true, content: 'awarded 5' })).toBe(
      'resolved',
    );
    await expect(pending).resolves.toEqual({ ok: true, content: 'awarded 5' });
  });

  it('gives up on a silent app and refuses its late answer', async () => {
    const registry = new AppToolRelayRegistry();
    const { relayId, stream } = openRegistered(registry);
    const binding = registry.listForSession({ projectId: 'trips', gezelId: 'gids' })[0];
    if (!binding) throw new Error('no binding');

    const pending = registry.invoke(binding, {
      tool: 'add_travel_points',
      args: {},
      sessionId: 's1',
      gezelId: 'gids',
      projectId: 'trips',
      timeoutMs: 1_000,
    });
    const call = lastCall(stream);
    await vi.advanceTimersByTimeAsync(1_001);

    await expect(pending).resolves.toEqual({
      ok: false,
      error: 'app "qualla" did not answer add_travel_points within 1s',
    });
    // The model has already been told the call failed; accepting the answer
    // now would leave the app believing it was used.
    expect(registry.resolveCall(relayId, call.callId, { ok: true, content: 'late' })).toBe(
      'unknown',
    );
  });

  it('fails fast instead of queueing while the app is disconnected', async () => {
    const registry = new AppToolRelayRegistry();
    const { relayId, attached } = openRegistered(registry);
    const binding = registry.listForSession({ projectId: 'trips', gezelId: 'gids' })[0];
    if (!binding) throw new Error('no binding');
    attached.detach();

    await expect(
      registry.invoke(binding, {
        tool: 'add_travel_points',
        args: {},
        sessionId: 's1',
        gezelId: 'gids',
        projectId: 'trips',
      }),
    ).resolves.toEqual({ ok: false, error: 'app "qualla" is not connected' });
    // Still registered: the grace window is running, not expired.
    expect(registry.has(relayId)).toBe(true);
  });

  it('keeps tools across a reconnect inside the grace window and drops them after', async () => {
    const registry = new AppToolRelayRegistry({ graceMs: 5_000 });
    const { relayId, attached } = openRegistered(registry);

    attached.detach();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(registry.listForSession({ projectId: 'trips', gezelId: 'gids' })).toHaveLength(1);

    const second = sink();
    registry.attachStream(relayId, second);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(registry.listForSession({ projectId: 'trips', gezelId: 'gids' })).toHaveLength(1);

    registry.attachStream(relayId, second).detach();
    await vi.advanceTimersByTimeAsync(5_001);
    expect(registry.listForSession({ projectId: 'trips', gezelId: 'gids' })).toEqual([]);
    expect(registry.has(relayId)).toBe(false);
  });

  it('lets a fresh stream supersede a half-open one', () => {
    const registry = new AppToolRelayRegistry();
    const { relayId, stream } = openRegistered(registry);
    const second = sink();

    registry.attachStream(relayId, second);

    expect(stream.events.at(-1)).toEqual({ type: 'closed', reason: 'superseded' });
    expect(second.events[0]).toMatchObject({ type: 'ready' });
  });

  it("refuses to shadow a built-in tool or another app's name", () => {
    const registry = new AppToolRelayRegistry();
    const { relayId } = registry.open({ appId: 'qualla' });
    registry.attachStream(relayId, sink());

    expect(() =>
      registry.register(relayId, {
        projectId: 'trips',
        tools: [{ ...TOOL, name: 'read_file' }],
      }),
    ).toThrow(expect.objectContaining({ code: 'tool_name_reserved' }));

    registry.register(relayId, { projectId: 'trips', tools: [TOOL] });
    const other = registry.open({ appId: 'rival' });
    registry.attachStream(other.relayId, sink());
    expect(() => registry.register(other.relayId, { projectId: 'trips', tools: [TOOL] })).toThrow(
      expect.objectContaining({ code: 'tool_name_conflict' }),
    );

    // The same app may always replace its own registration.
    expect(() => registry.register(relayId, { projectId: 'trips', tools: [TOOL] })).not.toThrow();
  });

  it('caps relays per app and reports an unknown relay', () => {
    const registry = new AppToolRelayRegistry({ maxRelaysPerApp: 2 });
    registry.open({ appId: 'qualla' });
    registry.open({ appId: 'qualla' });
    expect(() => registry.open({ appId: 'qualla' })).toThrow(
      expect.objectContaining({ code: 'too_many_relays' }),
    );
    // A different app is unaffected by another's budget.
    expect(() => registry.open({ appId: 'other' })).not.toThrow();
    expect(() => registry.register('nope', { projectId: 'trips', tools: [TOOL] })).toThrow(
      AppToolRelayError,
    );
  });

  it('refuses more calls than the app can plausibly be working on', async () => {
    const registry = new AppToolRelayRegistry({ maxPendingPerRelay: 1 });
    const { stream } = openRegistered(registry);
    const binding = registry.listForSession({ projectId: 'trips', gezelId: 'gids' })[0];
    if (!binding) throw new Error('no binding');
    const call = {
      tool: 'add_travel_points',
      args: {},
      sessionId: 's1',
      gezelId: 'gids',
      projectId: 'trips',
    };

    const first = registry.invoke(binding, call);
    const second = await registry.invoke(binding, call);
    expect(second).toMatchObject({ ok: false });
    expect(second.ok === false && second.error).toContain('too many tool calls in flight');

    registry.resolveCall(binding.relayId, lastCall(stream).callId, { ok: true, content: 'ok' });
    await expect(first).resolves.toMatchObject({ ok: true });
  });

  it('moves the project fingerprint whenever the surface changes', () => {
    const changed: string[] = [];
    const registry = new AppToolRelayRegistry({ onChange: (id) => changed.push(id) });
    expect(registry.fingerprint('trips')).toBe('');

    const { relayId } = registry.open({ appId: 'qualla' });
    registry.attachStream(relayId, sink());
    registry.register(relayId, { projectId: 'trips', tools: [TOOL] });
    const registered = registry.fingerprint('trips');
    expect(registered).not.toBe('');
    expect(changed).toEqual(['trips']);

    registry.register(relayId, {
      projectId: 'trips',
      tools: [{ ...TOOL, description: 'Award points, generously.' }],
    });
    expect(registry.fingerprint('trips')).not.toBe(registered);

    registry.unregister(relayId, 'trips');
    expect(registry.fingerprint('trips')).toBe('');
  });

  it('closes every relay and settles pending calls on daemon shutdown', async () => {
    const registry = new AppToolRelayRegistry();
    const { stream } = openRegistered(registry);
    const binding = registry.listForSession({ projectId: 'trips', gezelId: 'gids' })[0];
    if (!binding) throw new Error('no binding');
    const pending = registry.invoke(binding, {
      tool: 'add_travel_points',
      args: {},
      sessionId: 's1',
      gezelId: 'gids',
      projectId: 'trips',
    });

    registry.closeAll('daemon_shutdown');

    await expect(pending).resolves.toMatchObject({ ok: false });
    expect(stream.events.at(-1)).toEqual({ type: 'closed', reason: 'daemon_shutdown' });
    expect(registry.listForSession({ projectId: 'trips', gezelId: 'gids' })).toEqual([]);
  });

  it('lists a relay for its own app only', () => {
    const registry = new AppToolRelayRegistry();
    const { relayId } = openRegistered(registry);
    const other = registry.open({ appId: 'rival' });

    const mine = registry.listRelays({ appId: 'qualla' });
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      relayId,
      appId: 'qualla',
      connected: true,
      bindings: [{ projectId: 'trips', tools: ['add_travel_points'] }],
    });
    expect(registry.listRelays()).toHaveLength(2);
    expect(registry.ownerOf(other.relayId)).toBe('rival');
  });
});
