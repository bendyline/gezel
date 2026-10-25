import { describe, expect, it } from 'vitest';
import {
  type RequestLineageReader,
  type RequestLineageSession,
  type RequestLineageTask,
  deriveTaskRequestRef,
  isPersonMessage,
  latestPersonMessage,
  requestKey,
} from './identity.js';

function reader(
  tasks: RequestLineageTask[],
  sessions: RequestLineageSession[],
): RequestLineageReader {
  return {
    task: async (ref) => tasks.find((t) => t.ref === ref) ?? null,
    session: async (id) => sessions.find((s) => s.id === id) ?? null,
  };
}

const meesterThread: RequestLineageSession = {
  id: 'meester',
  messages: [
    { role: 'user', at: '2026-10-23T09:00:00Z', id: 'm1' },
    { role: 'assistant', at: '2026-10-23T09:00:05Z' },
    { role: 'user', at: '2026-10-23T09:10:00Z', id: 'm2' },
    { role: 'user', at: '2026-10-23T09:10:30Z', nudge: true },
    { role: 'assistant', at: '2026-10-23T09:11:00Z' },
  ],
};

describe('isPersonMessage', () => {
  it("is the person's own words, not a gezel, a seed, a nudge or a hidden reaction", () => {
    expect(isPersonMessage({ role: 'user', at: 'a' })).toBe(true);
    expect(isPersonMessage({ role: 'assistant', at: 'a' })).toBe(false);
    expect(isPersonMessage({ role: 'user', at: 'a', from: { gezelId: 'g', gezelName: 'G' } })).toBe(
      false,
    );
    expect(isPersonMessage({ role: 'user', at: 'a', origin: 'system' })).toBe(false);
    expect(isPersonMessage({ role: 'user', at: 'a', nudge: true })).toBe(false);
    expect(isPersonMessage({ role: 'user', at: 'a', hidden: true })).toBe(false);
  });

  it('reads the first user message of an older task session as its seed', () => {
    const session = {
      taskRef: 'p/1',
      messages: [
        { role: 'user' as const, at: 'a' },
        { role: 'user' as const, at: 'b' },
      ],
    };
    expect(isPersonMessage(session.messages[0]!, session)).toBe(false);
    expect(isPersonMessage(session.messages[1]!, session)).toBe(true);
  });

  it('finds the newest person message at or before a time', () => {
    expect(latestPersonMessage(meesterThread)?.id).toBe('m2');
    expect(latestPersonMessage(meesterThread, '2026-10-23T09:05:00Z')?.id).toBe('m1');
  });
});

describe('deriveTaskRequestRef', () => {
  const at = '2026-10-23T09:10:40Z';

  it('answers the message the launching thread was on, skipping the nudge', async () => {
    const task = { ref: 'p/1', launchSessionId: 'meester', createdAt: at };
    await expect(deriveTaskRequestRef(task, reader([], [meesterThread]))).resolves.toEqual({
      sessionId: 'meester',
      at: '2026-10-23T09:10:00Z',
      messageId: 'm2',
    });
  });

  it('keeps a ref already stamped', async () => {
    const stamped = { sessionId: 's', at: 't' };
    const task = { ref: 'p/1', requestRef: stamped, launchSessionId: 'meester', createdAt: at };
    await expect(deriveTaskRequestRef(task, reader([], [meesterThread]))).resolves.toBe(stamped);
  });

  it('gives a fanout child and a task launched from a step session the same request', async () => {
    const host: RequestLineageTask = { ref: 'p/1', launchSessionId: 'meester', createdAt: at };
    const step: RequestLineageSession = {
      id: 'step',
      taskRef: 'p/1',
      parentSession: { sessionId: 'meester', gezelId: 'mees', kind: 'task-entry' },
      messages: [{ role: 'user', at, origin: 'system' }],
    };
    const r = reader([host], [meesterThread, step]);
    const child = { ref: 'p/2', parentTaskRef: 'p/1', createdAt: at };
    const fromStep = { ref: 'p/3', launchSessionId: 'step', createdAt: at };
    const want = { sessionId: 'meester', at: '2026-10-23T09:10:00Z', messageId: 'm2' };
    await expect(deriveTaskRequestRef(child, r)).resolves.toEqual(want);
    await expect(deriveTaskRequestRef(fromStep, r)).resolves.toEqual(want);
  });

  it("follows a gezel's message back to the thread it came from, across projects", async () => {
    const voorman: RequestLineageSession = {
      id: 'voorman',
      messages: [
        {
          role: 'user',
          at: '2026-10-23T09:10:20Z',
          from: { gezelId: 'mees', gezelName: 'Mees', sessionId: 'meester' },
        },
      ],
    };
    const task = { ref: 'shop/1', launchSessionId: 'voorman', createdAt: at };
    await expect(
      deriveTaskRequestRef(task, reader([], [meesterThread, voorman])),
    ).resolves.toMatchObject({ sessionId: 'meester', messageId: 'm2' });
  });

  it("walks a delegated session's seed up to its parent", async () => {
    const delegated: RequestLineageSession = {
      id: 'delegated',
      parentSession: { sessionId: 'meester', gezelId: 'mees', kind: 'delegation' },
      messages: [{ role: 'user', at: '2026-10-23T09:10:20Z', origin: 'system' }],
    };
    const task = { ref: 'p/1', launchSessionId: 'delegated', createdAt: at };
    await expect(
      deriveTaskRequestRef(task, reader([], [meesterThread, delegated])),
    ).resolves.toMatchObject({ sessionId: 'meester', at: '2026-10-23T09:10:00Z' });
  });

  it('gives up on a missing link or a cycle', async () => {
    await expect(
      deriveTaskRequestRef({ launchSessionId: 'gone', createdAt: at }, reader([], [])),
    ).resolves.toBeUndefined();
    const loop: RequestLineageTask = { ref: 'p/1', parentTaskRef: 'p/1', createdAt: at };
    await expect(deriveTaskRequestRef(loop, reader([loop], []))).resolves.toBeUndefined();
    await expect(deriveTaskRequestRef({ createdAt: at }, reader([], []))).resolves.toBeUndefined();
  });

  it('keys a request by thread and time', () => {
    expect(requestKey({ sessionId: 'meester', at: '2026-10-23T09:10:00Z' })).toBe(
      'meester@2026-10-23T09:10:00Z',
    );
  });
});
