import { describe, expect, it } from 'vitest';
import {
  type QueuedSendOptions,
  type SessionQueueEvent,
  SessionSendQueue,
} from './session-send-queue.js';

function harness() {
  const events: Array<{ sessionId: string; event: SessionQueueEvent }> = [];
  let clock = 1_000;
  let ids = 0;
  const queue = new SessionSendQueue<string>({
    publish: (sessionId, event) => events.push({ sessionId, event }),
    now: () => clock,
    newId: () => `q${++ids}`,
  });
  return {
    queue,
    events,
    tick(ms: number) {
      clock += ms;
    },
    types: () => events.map(({ event }) => `${event.type}:${event.queueId}`),
  };
}

const user: QueuedSendOptions = { messageOrigin: 'direct-user' };
const fromMaya = { gezelId: 'maya', gezelName: 'Maya' };

function queued<R>(admission: ReturnType<SessionSendQueue<R>['admit']>) {
  if (!admission.queued) throw new Error('expected the send to queue');
  return admission;
}

describe('SessionSendQueue — admission', () => {
  it('runs a send on an idle session with an empty queue', () => {
    const { queue, events } = harness();
    const admission = queue.admit('s', false, 'hello', user);
    expect(admission).toEqual({ queued: false, runOptions: user });
    expect(events).toEqual([]);
  });

  it('strips the nudge flag from a nudge that never queued, keeping its origin', () => {
    const { queue } = harness();
    const admission = queue.admit('s', false, 'hi', {
      messageOrigin: 'background-nudge',
      nudge: true,
    });
    expect(admission).toEqual({
      queued: false,
      runOptions: { messageOrigin: 'background-nudge', nudge: false },
    });
  });

  it('queues while busy, and behind existing entries even when not busy', () => {
    const { queue, types } = harness();
    queued(queue.admit('s', true, 'first', user));
    const second = queued(queue.admit('s', false, 'second', user));
    expect(second.depth).toBe(2);
    expect(queue.depth('s')).toBe(2);
    expect(types()).toEqual(['queue_enqueued:q1', 'queue_enqueued:q2']);
  });

  it('adds the entry before admit returns', () => {
    const { queue } = harness();
    queue.admit('s', true, 'now', user);
    expect(queue.listSession('s').map((e) => e.text)).toEqual(['now']);
  });
});

describe('SessionSendQueue — enqueue-time coalescing', () => {
  it('merges coalescable sends from one sender and re-publishes under the same id', () => {
    const { queue, events } = harness();
    const a = queued(queue.admit('s', true, 'one', { ...user, coalescable: true }));
    const b = queued(queue.admit('s', true, 'two', { ...user, coalescable: true }));
    expect(b).toMatchObject({ queueId: a.queueId, merged: true, depth: 1, waiters: 2 });
    expect(queue.listSession('s')[0]?.text).toBe('one\n\ntwo');
    expect(events.map(({ event }) => event.queueId)).toEqual(['q1', 'q1']);
  });

  it('keeps a merged turn visible when either part was visible', async () => {
    const { queue } = harness();
    queue.admit('s', true, 'seed', { ...user, coalescable: true, hidden: true });
    queue.admit('s', true, 'shown', { ...user, coalescable: true });
    let seen: unknown;
    queue.dispatchNext('s', async (_text, opts) => {
      seen = opts;
      return 'ok';
    });
    expect(seen).not.toHaveProperty('hidden');
  });

  it.each([
    ['a non-coalescable tail', { ...user }, { ...user, coalescable: true }],
    ['a nudge', { ...user, coalescable: true }, { ...user, coalescable: true, nudge: true }],
    [
      'a different origin',
      { ...user, coalescable: true },
      { messageOrigin: 'system' as const, coalescable: true },
    ],
    [
      'a different sender',
      { ...user, coalescable: true },
      { ...user, coalescable: true, from: fromMaya },
    ],
    [
      'a file-turn intent',
      { ...user, coalescable: true },
      {
        ...user,
        coalescable: true,
        fileTurnIntent: { kind: 'repair-file' as const, path: 'lib/parser.py' },
      },
    ],
  ])('never merges across %s', (_label, first, second) => {
    const { queue } = harness();
    queue.admit('s', true, 'one', first);
    const next = queued(queue.admit('s', true, 'two', second));
    expect(next.merged).toBe(false);
    expect(queue.depth('s')).toBe(2);
  });
});

describe('SessionSendQueue — dispatch', () => {
  it('runs synchronously and settles the caller with the result', async () => {
    const { queue } = harness();
    const entry = queued(queue.admit('s', true, 'go', user));
    let ran = false;
    const dispatched = queue.dispatchNext('s', async () => {
      ran = true;
      return 'reply';
    });
    expect(dispatched).toBe(true);
    expect(ran).toBe(true);
    await expect(entry.result).resolves.toBe('reply');
    expect(queue.depth('s')).toBe(0);
    expect(queue.sessionIds()).toEqual([]);
  });

  it('rejects every waiter when the run fails', async () => {
    const { queue } = harness();
    const a = queued(queue.admit('s', true, 'one', { ...user, coalescable: true }));
    const b = queued(queue.admit('s', true, 'two', { ...user, coalescable: true }));
    queue.dispatchNext('s', async () => {
      throw new Error('boom');
    });
    await expect(a.result).rejects.toThrow('boom');
    await expect(b.result).rejects.toThrow('boom');
  });

  it('returns false for an empty queue', () => {
    const { queue } = harness();
    expect(queue.dispatchNext('s', async () => 'x')).toBe(false);
  });

  it('merges contiguous same-bucket nudges and removes absorbed entries before the head', async () => {
    const { queue, types } = harness();
    const n1 = queued(queue.admit('s', true, 'n1', { ...user, nudge: true, draftId: 'd1' }));
    const n2 = queued(queue.admit('s', true, 'n2', { ...user, nudge: true, draftId: 'd2' }));
    let run: { text: string; opts: unknown } | undefined;
    queue.dispatchNext('s', async (text, opts) => {
      run = { text, opts };
      return 'merged';
    });
    expect(run).toEqual({
      text: 'n1\n\nn2',
      opts: { messageOrigin: 'direct-user', nudge: true, draftId: 'd1' },
    });
    expect(types().slice(-2)).toEqual(['queue_removed:q2', 'queue_removed:q1']);
    await expect(n1.result).resolves.toBe('merged');
    await expect(n2.result).resolves.toBe('merged');
  });

  it.each([
    ['a non-nudge entry', { ...user }],
    ['a different sender', { ...user, nudge: true, from: fromMaya }],
    ['a hidden nudge', { ...user, nudge: true, hidden: true }],
    [
      'a file-turn intent',
      { ...user, nudge: true, fileTurnIntent: { kind: 'create-file' as const, path: 'out.md' } },
    ],
  ])('stops a nudge merge at %s', (_label, second) => {
    const { queue } = harness();
    queue.admit('s', true, 'n1', { ...user, nudge: true });
    queue.admit('s', true, 'two', second);
    let text = '';
    queue.dispatchNext('s', async (t) => {
      text = t;
      return '';
    });
    expect(text).toBe('n1');
    expect(queue.depth('s')).toBe(1);
  });

  it('passes only truthy run options, like a direct send', () => {
    const { queue } = harness();
    queue.admit('s', true, 'x', {
      ...user,
      coalescable: true,
      ambient: false,
      hidden: false,
      continuationMaxTokens: 0,
      lane: 'background',
    });
    let opts: unknown;
    queue.dispatchNext('s', async (_t, o) => {
      opts = o;
      return '';
    });
    expect(opts).toEqual({ messageOrigin: 'direct-user', lane: 'background' });
  });
});

describe('SessionSendQueue — interrupt, edit, discard, reject', () => {
  it('puts an interrupt at the front as a non-nudge that nothing merges into', () => {
    const { queue } = harness();
    queue.admit('s', true, 'n1', { ...user, nudge: true });
    const front = queue.enqueueFront('s', 'stop and do this', { ...user, draftId: 'd9' });
    expect(front.depth).toBe(2);
    let first = '';
    queue.dispatchNext('s', async (text) => {
      first = text;
      return '';
    });
    expect(first).toBe('stop and do this');
    expect(queue.listSession('s').map((e) => e.text)).toEqual(['n1']);
  });

  it('edits in place, keeping position and enqueue time', () => {
    const { queue, tick, events } = harness();
    const a = queued(queue.admit('s', true, 'old', user));
    queue.admit('s', true, 'later', user);
    tick(5_000);
    const updated = queue.update('s', a.queueId, 'new');
    expect(updated).toMatchObject({ queueId: a.queueId, text: 'new', nudge: false });
    expect(updated?.enqueuedAt).toBe(new Date(1_000).toISOString());
    expect(queue.listSession('s').map((e) => e.text)).toEqual(['new', 'later']);
    expect(events.at(-1)?.event).toMatchObject({ type: 'queue_enqueued', queueId: a.queueId });
    expect(queue.update('s', 'gone', 'x')).toBeNull();
  });

  it('discards one entry and rejects its caller', async () => {
    const { queue, types } = harness();
    const a = queued(queue.admit('s', true, 'drop me', user));
    expect(queue.cancel('s', a.queueId)).toBe(true);
    await expect(a.result).rejects.toThrow('queued message canceled by user');
    expect(types().at(-1)).toBe(`queue_removed:${a.queueId}`);
    expect(queue.sessionIds()).toEqual([]);
    expect(queue.cancel('s', a.queueId)).toBe(false);
  });

  it('rejects a whole session with the host error, removing the list first', async () => {
    const { queue, events } = harness();
    const a = queued(queue.admit('s', true, 'one', user));
    const b = queued(queue.admit('s', true, 'two', user));
    const err = new Error('send rejected: archived');
    let depthDuringReject = -1;
    a.result.catch(() => {
      depthDuringReject = queue.depth('s');
    });
    expect(queue.rejectSession('s', err)).toBe(2);
    await expect(a.result).rejects.toBe(err);
    await expect(b.result).rejects.toBe(err);
    expect(depthDuringReject).toBe(0);
    expect(events.slice(-2).map(({ event }) => event)).toEqual([
      { type: 'queue_removed', queueId: 'q1', reason: 'rejected' },
      { type: 'queue_removed', queueId: 'q2', reason: 'rejected' },
    ]);
    expect(queue.rejectSession('s', err)).toBe(0);
  });
});

describe('SessionSendQueue — snapshots', () => {
  it('lists previews across sessions with the provider each session is pinned to', () => {
    const { queue } = harness();
    const long = 'x'.repeat(200);
    queue.admit('a', true, long, { ...user, nudge: true });
    queue.admit('b', true, 'short', user);
    expect(queue.totalDepth()).toBe(2);
    const listed = queue.list((id) => (id === 'a' ? 'llama-cpp' : undefined));
    expect(listed).toHaveLength(2);
    expect(listed[0]).toMatchObject({
      sessionId: 'a',
      providerName: 'llama-cpp',
      depth: 1,
      nextPreview: `${'x'.repeat(117)}…`,
    });
    expect(listed[0]?.entries[0]).toMatchObject({ preview: `${'x'.repeat(157)}…`, nudge: true });
    expect(listed[1]).not.toHaveProperty('providerName');
    expect(listed[1]?.entries[0]).not.toHaveProperty('nudge');
  });
});
