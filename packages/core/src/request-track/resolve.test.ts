import { describe, expect, it } from 'vitest';
import type { Question } from '../schemas/question.js';
import type { Task } from '../schemas/task.js';
import { stepDurationEstimates } from './eta.js';
import {
  NOW,
  T,
  closingTurn,
  draftTurn,
  invoiceShard,
  invoices,
  meesterThread,
  priceList,
} from './fixtures/bakery.js';
import {
  type RequestThread,
  type RequestTrackInput,
  assembleRequestTracks,
  resolveRequestTracks,
} from './resolve.js';

const base = (over: Partial<RequestTrackInput> = {}): RequestTrackInput => ({
  tasks: [invoices, invoiceShard, priceList],
  threads: new Map([[meesterThread.id, meesterThread]]),
  inflight: [draftTurn, closingTurn],
  waiting: [{ ref: 'bakery/4', reason: 'provider-busy', gezelId: 'aditya', since: T(26) }],
  questions: [],
  leadOf: (projectId) => (projectId === 'bakery' ? 'dejan' : 'mees'),
  estimates: stepDurationEstimates([]),
  now: NOW,
  ...over,
});

describe('resolveRequestTracks on the bakery', () => {
  it('gives each person message one tracker, newest first, the lead speaking', () => {
    const [prices, work] = resolveRequestTracks(base());
    expect([prices?.key, work?.key]).toEqual([`mees-thread@${T(20)}`, `mees-thread@${T(0)}`]);
    expect(work).toMatchObject({
      kind: 'work',
      summary: 'Make my October invoices for the three cafe clients',
      leadGezelId: 'dejan',
      stop: 'making',
      state: 'working',
      line: { gezelId: 'dejan', doing: 'is drafting the invoices' },
      actual: { gezelId: 'aditya', taskRef: 'bakery/1', stepId: 'draft' },
      taskRefs: ['bakery/1', 'bakery/4'],
      parts: { done: 0, total: 1 },
      liveSessionIds: ['step-draft'],
      questionIds: [],
    });
    expect(work?.crew).toContain('aditya');
    expect(work?.crew).not.toContain('dejan');
    expect(work?.eta?.text).toMatch(/^First time here: about \d+ minutes$/);
  });

  it('is Ready with the wrap-up deliverable, still wrapping up while the Meester writes', () => {
    const [prices] = resolveRequestTracks(base());
    expect(prices).toMatchObject({
      stop: 'ready',
      state: 'ready',
      trailing: true,
      line: { doing: 'is wrapping up' },
      deliverable: { kind: 'artifact', path: 'tasks/2/report.pdf', projectId: 'bakery' },
      makerGezelId: 'aditya',
      liveSessionIds: ['mees-thread'],
    });
    expect(prices?.eta).toBeUndefined();
    const settled = resolveRequestTracks(base({ inflight: [draftTurn] }))[0];
    expect(settled?.trailing).toBeUndefined();
    expect(settled?.line).toBeUndefined();
  });

  it('says why it is waiting when the engine holds the turn', () => {
    const held = resolveRequestTracks(
      base({ inflight: [{ ...draftTurn, engineHold: 'behind' }] }),
    )[1];
    expect(held).toMatchObject({
      state: 'waiting',
      line: { doing: 'is waiting for another chat to finish' },
    });
  });

  it('asks the person when a task does', () => {
    const question = {
      id: 'q1',
      projectId: 'bakery',
      gezelId: 'aditya',
      sessionId: 'step-draft',
      taskRef: 'bakery/1',
      prompt: 'Which VAT rate?',
      createdAt: T(27),
    } as Question;
    const work = resolveRequestTracks(base({ questions: [question] }))[1];
    expect(work).toMatchObject({
      state: 'needs-you',
      line: { doing: 'has a question for you' },
      questionIds: ['q1'],
    });
  });

  it('never moves back a stop when a review sends the work back', () => {
    const looped = structuredClone(invoices) as Task;
    looped.craftbook.steps[2]!.completedAt = T(25);
    const work = resolveRequestTracks(base({ tasks: [looped], inflight: [draftTurn] }))[0];
    expect(work?.key).toBe(`mees-thread@${T(0)}`);
    expect(work?.stop).toBe('checking');
  });

  it('shows Got it while a reply is still being written with no work yet', () => {
    const thread: RequestThread = {
      id: 'shop-thread',
      gezelId: 'mees',
      projectId: 'default',
      messages: [{ id: 'm9', role: 'user', at: T(29), content: 'What did we bill Noord?' }],
    };
    const tracks = resolveRequestTracks(
      base({
        tasks: [],
        threads: new Map([[thread.id, thread]]),
        inflight: [{ ...closingTurn, sessionId: 'shop-thread', startedAt: NOW }],
      }),
    );
    expect(tracks).toEqual([
      expect.objectContaining({
        key: `shop-thread@${T(29)}`,
        kind: 'conversation',
        stop: 'got-it',
        state: 'working',
        line: { gezelId: 'mees', doing: 'is looking into it' },
      }),
    ]);
  });

  it('reads a request of only canceled work as stopped', () => {
    const canceled = { ...invoices, status: 'canceled' } as Task;
    const work = resolveRequestTracks(base({ tasks: [canceled], inflight: [] }))[0];
    expect(work).toMatchObject({ state: 'stopped', line: { doing: 'stopped working on this' } });
  });
});

describe('assembleRequestTracks', () => {
  it('derives the request of a task recorded before requests were stamped', async () => {
    const older = { ...invoices, requestRef: undefined, updatedAt: T(26) } as Task;
    const tracks = await assembleRequestTracks(
      {
        tasks: [older, priceList],
        session: async (id) => (id === meesterThread.id ? meesterThread : null),
        project: async (id) => ({ id, ...(id === 'bakery' ? { voormanGezelId: 'dejan' } : {}) }),
        meesterGezelId: 'mees',
        inflight: [draftTurn],
        waiting: [],
        questions: [],
        estimates: stepDurationEstimates([]),
        now: NOW,
      },
      { sessions: ['mees-thread'], live: true },
    );
    // The finished price list is not live; the invoices are, under m1.
    expect(tracks.map((t) => [t.key, t.messageId, t.leadGezelId])).toEqual([
      [`mees-thread@${T(0)}`, 'm1', 'dejan'],
    ]);
  });
});
