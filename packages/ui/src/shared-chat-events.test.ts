import type { ChatEventEnvelope } from '@bendyline/gezel';
import type { SseStreamOptions } from '@bendyline/gezel-client';
import { describe, expect, it, vi } from 'vitest';

const streams = vi.hoisted(() => ({
  all: vi.fn(),
  project: vi.fn(),
}));

vi.mock('@bendyline/gezel-client', () => ({
  streamAllChatEvents: streams.all,
  streamProjectChatEvents: streams.project,
}));

const { streamSharedAllChatEvents } = await import('./shared-chat-events.js');

const firstEnvelope: ChatEventEnvelope = {
  sessionId: 'session-1',
  gezelId: 'gezel-1',
  projectId: 'project-1',
  event: { type: 'index_progress', phase: 'scan', state: 'started' },
};

const secondEnvelope: ChatEventEnvelope = {
  ...firstEnvelope,
  event: { type: 'index_progress', phase: 'scan', state: 'ended' },
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('shared chat events', () => {
  it('fans one upstream stream out to subscribers with independent cancellation', async () => {
    const first = deferred();
    const second = deferred();
    const finish = deferred();
    streams.all.mockImplementation(async function* (_opts: SseStreamOptions) {
      await first.promise;
      yield firstEnvelope;
      await second.promise;
      yield secondEnvelope;
      await finish.promise;
    });

    const firstController = new AbortController();
    const secondController = new AbortController();
    const opts = {
      url: 'http://127.0.0.1/events/chat/all',
      headers: { Authorization: 'Bearer x' },
    };
    const firstSubscriber = streamSharedAllChatEvents({
      ...opts,
      signal: firstController.signal,
    });
    const secondSubscriber = streamSharedAllChatEvents({
      ...opts,
      signal: secondController.signal,
    });

    const firstNext = firstSubscriber.next();
    const secondNext = secondSubscriber.next();
    expect(streams.all).toHaveBeenCalledTimes(1);

    first.resolve();
    await expect(firstNext).resolves.toEqual({ done: false, value: firstEnvelope });
    await expect(secondNext).resolves.toEqual({ done: false, value: firstEnvelope });

    firstController.abort();
    await expect(firstSubscriber.next()).resolves.toEqual({ done: true, value: undefined });
    expect((streams.all.mock.calls[0]?.[0] as SseStreamOptions).signal?.aborted).toBe(false);

    const remainingNext = secondSubscriber.next();
    second.resolve();
    await expect(remainingNext).resolves.toEqual({ done: false, value: secondEnvelope });

    secondController.abort();
    await expect(secondSubscriber.next()).resolves.toEqual({ done: true, value: undefined });
    expect((streams.all.mock.calls[0]?.[0] as SseStreamOptions).signal?.aborted).toBe(true);
    finish.resolve();
  });

  it('replays cached in-flight envelopes (deltas coalesced) to a late subscriber', async () => {
    // The service-side bus only replays history to a fresh HTTP
    // connection. When an always-mounted surface keeps the shared
    // upstream open, a chat timeline that remounts after a tab switch
    // joins this fan-out instead — without a client-side replay it
    // would lose every delta accumulated during the gap.
    const gate = deferred();
    const finish = deferred();
    streams.all.mockReset();
    streams.all.mockImplementation(async function* (_opts: SseStreamOptions) {
      yield {
        sessionId: 's1',
        gezelId: 'g1',
        projectId: 'p1',
        event: { type: 'user_message', message: { role: 'user', content: 'hi', at: 't0' } },
      } satisfies ChatEventEnvelope;
      yield {
        sessionId: 's1',
        gezelId: 'g1',
        projectId: 'p1',
        event: { type: 'delta', content: 'Hel' },
      } satisfies ChatEventEnvelope;
      yield {
        sessionId: 's1',
        gezelId: 'g1',
        projectId: 'p1',
        event: { type: 'heartbeat', label: 'thinking' },
      } satisfies ChatEventEnvelope;
      yield {
        sessionId: 's1',
        gezelId: 'g1',
        projectId: 'p1',
        event: { type: 'delta', content: 'lo' },
      } satisfies ChatEventEnvelope;
      await gate.promise;
      yield {
        sessionId: 's1',
        gezelId: 'g1',
        projectId: 'p1',
        event: { type: 'done' },
      } satisfies ChatEventEnvelope;
      await finish.promise;
    });

    const opts = {
      url: 'http://127.0.0.1/events/chat/all',
      headers: { Authorization: 'Bearer y' },
    };
    const early = streamSharedAllChatEvents({ ...opts, signal: new AbortController().signal });
    // Drain the four live envelopes so the upstream has definitely
    // pumped them into the replay cache.
    for (let i = 0; i < 4; i++) await early.next();

    const late = streamSharedAllChatEvents({ ...opts, signal: new AbortController().signal });
    const replayedFirst = await late.next();
    const replayedSecond = await late.next();
    expect(replayedFirst.value?.event.type).toBe('user_message');
    // Adjacent deltas coalesce into one; the transient heartbeat between
    // them is not replayed at all.
    expect(replayedSecond.value?.event).toEqual({ type: 'delta', content: 'Hello' });

    // `done` clears the session's cache — a third subscriber joining
    // after the turn completes replays nothing.
    gate.resolve();
    await late.next(); // live `done`
    const afterDone = streamSharedAllChatEvents({ ...opts, signal: new AbortController().signal });
    const pending = afterDone.next();
    const raced = await Promise.race([
      pending.then(() => 'delivered'),
      new Promise((resolve) => setTimeout(() => resolve('empty'), 20)),
    ]);
    expect(raced).toBe('empty');
    finish.resolve();
  });
});
