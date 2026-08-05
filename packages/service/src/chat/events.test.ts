import type { ChatEvent, ChatEventEnvelope } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { ChatEventBus } from './events.js';

describe('ChatEventBus — mid-stream replay on subscribeProject', () => {
  it('replays in-flight session history to a project subscriber that joins late', async () => {
    // The user-facing scenario this protects: a user is watching
    // a project chat, a gezel starts streaming, the user tabs to
    // Settings (UI unmounts the project subscriber), then back
    // (UI re-subscribes). Without replay, every delta + tool that
    // arrived during the gap is lost — the bubble re-creates as
    // thinking-dots only.
    const bus = new ChatEventBus();
    const scope = { sessionId: 's1', gezelId: 'ada', projectId: 'eliza' };
    bus.publish(scope, {
      type: 'user_message',
      message: { role: 'user', content: 'hi', at: 't0' },
    });
    bus.publish(scope, { type: 'delta', content: 'Hello' });
    bus.publish(scope, { type: 'delta', content: ' there' });

    const seen: ChatEventEnvelope[] = [];
    bus.subscribeProject('eliza', (env) => seen.push(env));

    // Replayed BEFORE any new events. Adjacent deltas arrive coalesced
    // into one entry — same text, fewer events.
    expect(seen.map((e) => e.event.type)).toEqual(['user_message', 'delta']);
    expect(seen[1]?.event).toMatchObject({ type: 'delta', content: 'Hello there' });
    expect(seen.every((e) => e.sessionId === 's1' && e.projectId === 'eliza')).toBe(true);
  });

  it('does not replay events for other projects', async () => {
    const bus = new ChatEventBus();
    bus.publish(
      { sessionId: 's1', gezelId: 'ada', projectId: 'eliza' },
      { type: 'delta', content: 'eliza-only' },
    );
    bus.publish(
      { sessionId: 's2', gezelId: 'leo', projectId: 'shop' },
      { type: 'delta', content: 'shop-only' },
    );

    const seen: ChatEventEnvelope[] = [];
    bus.subscribeProject('eliza', (env) => seen.push(env));

    expect(seen).toHaveLength(1);
    expect(seen[0]?.event).toMatchObject({ type: 'delta', content: 'eliza-only' });
  });

  it('does not replay completed sessions (history cleared on done)', async () => {
    const bus = new ChatEventBus();
    const scope = { sessionId: 's1', gezelId: 'ada', projectId: 'eliza' };
    bus.publish(scope, { type: 'delta', content: 'streamed' });
    bus.publish(scope, {
      type: 'complete',
      message: { role: 'assistant', content: 'streamed', at: 't1' },
    });
    bus.publish(scope, { type: 'done' });

    const seen: ChatEventEnvelope[] = [];
    bus.subscribeProject('eliza', (env) => seen.push(env));

    expect(seen).toHaveLength(0);
  });

  it('replay precedes live events from later publishes', async () => {
    const bus = new ChatEventBus();
    const scope = { sessionId: 's1', gezelId: 'ada', projectId: 'eliza' };
    bus.publish(scope, { type: 'delta', content: 'pre-tab' });

    const order: string[] = [];
    bus.subscribeProject('eliza', (env) => {
      if (env.event.type === 'delta') order.push(env.event.content);
    });
    bus.publish(scope, { type: 'delta', content: 'post-tab' });

    expect(order).toEqual(['pre-tab', 'post-tab']);
  });
});

describe('ChatEventBus — mid-stream replay on subscribeAll', () => {
  it('replays every in-flight session across projects to a global subscriber', async () => {
    const bus = new ChatEventBus();
    bus.publish(
      { sessionId: 's1', gezelId: 'ada', projectId: 'eliza' },
      { type: 'delta', content: 'ada-mid' },
    );
    bus.publish(
      { sessionId: 's2', gezelId: 'leo', projectId: 'shop' },
      { type: 'delta', content: 'leo-mid' },
    );

    const seen: ChatEventEnvelope[] = [];
    bus.subscribeAll((env) => seen.push(env));

    expect(seen.map((e) => `${e.projectId}/${(e.event as { content?: string }).content}`)).toEqual([
      'eliza/ada-mid',
      'shop/leo-mid',
    ]);
  });
});

describe('ChatEventBus — publishProjectEvent (lifecycle signals)', () => {
  it('reaches global and project subscribers', () => {
    const bus = new ChatEventBus();
    const global: ChatEventEnvelope[] = [];
    const project: ChatEventEnvelope[] = [];
    bus.subscribeAll((env) => global.push(env));
    bus.subscribeProject('eliza', (env) => project.push(env));

    bus.publishProjectEvent('eliza', {
      type: 'project_created',
      projectId: 'eliza',
      name: 'Eliza',
    });

    expect(global).toHaveLength(1);
    expect(global[0]?.event).toMatchObject({ type: 'project_created', name: 'Eliza' });
    expect(global[0]?.projectId).toBe('eliza');
    expect(project).toHaveLength(1);
    expect(project[0]?.event).toMatchObject({ type: 'project_created', projectId: 'eliza' });
  });

  it('is NOT replayed to a subscriber that joins afterwards (one-shot, history-free)', () => {
    // A lifecycle signal isn't part of a replayable transcript — unlike
    // `publish`, it must not re-fire when a late subscriber connects, or
    // the sidebar would re-trigger a refresh on every reconnect.
    const bus = new ChatEventBus();
    bus.publishProjectEvent('eliza', {
      type: 'project_created',
      projectId: 'eliza',
      name: 'Eliza',
    });

    const late: ChatEventEnvelope[] = [];
    bus.subscribeAll((env) => late.push(env));
    bus.subscribeProject('eliza', (env) => late.push(env));

    expect(late).toHaveLength(0);
  });
});

describe('ChatEventBus — lossless replay history', () => {
  it('coalesces long delta streams so the 500-event cap does not drop thinking text', () => {
    // A reasoning-heavy turn streams thousands of per-token deltas.
    // Stored individually, only the last 500 survive for replay and a
    // user who tabs away mid-turn loses the earliest thinking. Merged
    // runs keep the full text in one history slot.
    const bus = new ChatEventBus();
    const scope = { sessionId: 's1', gezelId: 'ada', projectId: 'eliza' };
    for (let i = 0; i < 2000; i++) {
      bus.publish(scope, { type: 'delta', content: `t${i} ` });
    }

    const seen: ChatEventEnvelope[] = [];
    bus.subscribeProject('eliza', (env) => seen.push(env));

    expect(seen).toHaveLength(1);
    const content = (seen[0]?.event as { content: string }).content;
    expect(content.startsWith('t0 t1 ')).toBe(true);
    expect(content.endsWith('t1999 ')).toBe(true);
  });

  it('keeps delta runs separated by tool events as distinct entries, in order', () => {
    const bus = new ChatEventBus();
    const scope = { sessionId: 's1', gezelId: 'ada', projectId: 'eliza' };
    bus.publish(scope, { type: 'delta', content: 'before ' });
    bus.publish(scope, { type: 'delta', content: 'tool' });
    bus.publish(scope, { type: 'tool', name: 'write_file', durationMs: 5, success: true });
    bus.publish(scope, { type: 'delta', content: 'after' });

    const seen: ChatEventEnvelope[] = [];
    bus.subscribeProject('eliza', (env) => seen.push(env));

    expect(seen.map((e) => e.event.type)).toEqual(['delta', 'tool', 'delta']);
    expect(seen[0]?.event).toMatchObject({ content: 'before tool' });
    expect(seen[2]?.event).toMatchObject({ content: 'after' });
  });

  it('delivers heartbeat and wire_pulse live but never replays them', () => {
    const bus = new ChatEventBus();
    const scope = { sessionId: 's1', gezelId: 'ada', projectId: 'eliza' };
    const live: ChatEventEnvelope[] = [];
    bus.subscribeProject('eliza', (env) => live.push(env));

    bus.publish(scope, { type: 'delta', content: 'thinking…' });
    bus.publish(scope, { type: 'heartbeat', label: 'thinking' });
    bus.publish(scope, { type: 'wire_pulse' });
    expect(live.map((e) => e.event.type)).toEqual(['delta', 'heartbeat', 'wire_pulse']);

    const replayed: ChatEventEnvelope[] = [];
    bus.subscribeProject('eliza', (env) => replayed.push(env));
    expect(replayed.map((e) => e.event.type)).toEqual(['delta']);
  });

  it('coalesces tool_args_delta runs per tool name so mid-write reloads replay one entry', () => {
    // A multi-minute structured write_file streams thousands of arg
    // fragments. They coalesce like deltas — but only within the same
    // tool name, so two back-to-back calls stay distinct entries.
    const bus = new ChatEventBus();
    const scope = { sessionId: 's1', gezelId: 'ada', projectId: 'eliza' };
    bus.publish(scope, { type: 'tool_args_delta', name: 'write_file', content: '{"path":"a",' });
    bus.publish(scope, { type: 'tool_args_delta', name: 'write_file', content: '"content":"x"}' });
    bus.publish(scope, { type: 'tool_args_delta', name: 'read_file', content: '{"path":"b"}' });

    const seen: ChatEventEnvelope[] = [];
    bus.subscribeProject('eliza', (env) => seen.push(env));
    expect(seen.map((e) => e.event.type)).toEqual(['tool_args_delta', 'tool_args_delta']);
    expect(seen[0]?.event).toMatchObject({
      name: 'write_file',
      content: '{"path":"a","content":"x"}',
    });
    expect(seen[1]?.event).toMatchObject({ name: 'read_file', content: '{"path":"b"}' });
  });

  it('a heartbeat between deltas does not break coalescing', () => {
    const bus = new ChatEventBus();
    const scope = { sessionId: 's1', gezelId: 'ada', projectId: 'eliza' };
    bus.publish(scope, { type: 'delta', content: 'first ' });
    bus.publish(scope, { type: 'heartbeat' });
    bus.publish(scope, { type: 'delta', content: 'second' });

    const seen: ChatEventEnvelope[] = [];
    bus.subscribeProject('eliza', (env) => seen.push(env));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.event).toMatchObject({ type: 'delta', content: 'first second' });
  });

  it('keeps only the latest engine phase without evicting early tool activity', () => {
    const bus = new ChatEventBus();
    const scope = { sessionId: 's1', gezelId: 'ada', projectId: 'eliza' };
    bus.publish(scope, {
      type: 'user_message',
      message: { role: 'user', content: 'build it', at: 't0' },
    });
    bus.publish(scope, { type: 'tool', name: 'delegate_builder', durationMs: 5, success: true });
    for (let i = 0; i < 1000; i++) {
      bus.publish(scope, { type: 'delta', content: `t${i} ` });
      bus.publish(scope, {
        type: 'engine_phase',
        provider: 'mlx',
        phase: 'generating',
        detail: `Generating · ${i} tokens`,
      });
    }

    const seen: ChatEventEnvelope[] = [];
    bus.subscribeProject('eliza', (env) => seen.push(env));

    expect(seen.map((env) => env.event.type)).toEqual([
      'user_message',
      'tool',
      'delta',
      'engine_phase',
    ]);
    expect(seen[1]?.event).toMatchObject({ type: 'tool', name: 'delegate_builder' });
    expect(seen[2]?.event).toMatchObject({ type: 'delta' });
    expect((seen[2]?.event as { content: string }).content).toContain('t999 ');
    expect(seen[3]?.event).toMatchObject({ detail: 'Generating · 999 tokens' });
  });
});

describe('ChatEventBus — session-scoped replay (existing behavior)', () => {
  it('still replays history to a per-session subscriber', () => {
    const bus = new ChatEventBus();
    const scope = { sessionId: 's1', gezelId: 'ada', projectId: 'eliza' };
    bus.publish(scope, { type: 'delta', content: 'one' });
    bus.publish(scope, { type: 'delta', content: 'two' });

    const seen: ChatEvent[] = [];
    bus.subscribe('s1', (e) => seen.push(e));
    expect(seen).toEqual([{ type: 'delta', content: 'onetwo' }]);
  });

  it('does not retain a completed session after its last subscriber leaves', () => {
    const bus = new ChatEventBus();
    const stop = bus.subscribe('s1', () => {});
    bus.publish({ sessionId: 's1', gezelId: 'ada', projectId: 'eliza' }, { type: 'done' });
    expect(bus.activeSessionCount()).toBe(1);
    stop();
    expect(bus.activeSessionCount()).toBe(0);
  });

  it('isolates a throwing listener from other listeners', () => {
    const bus = new ChatEventBus();
    const seen: ChatEvent[] = [];
    bus.subscribe('s1', () => {
      throw new Error('broken consumer');
    });
    bus.subscribe('s1', (event) => seen.push(event));
    bus.publish(
      { sessionId: 's1', gezelId: 'ada', projectId: 'eliza' },
      { type: 'delta', content: 'still delivered' },
    );
    expect(seen).toEqual([{ type: 'delta', content: 'still delivered' }]);
  });
});
