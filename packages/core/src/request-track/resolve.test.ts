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

  // 2026-11-17: one shard queued behind its sibling put a running review under Next.
  it('is working while any of its turns runs, even with another held behind it', () => {
    const sibling = {
      ...draftTurn,
      sessionId: 'step-shard',
      taskRef: 'bakery/4',
      engineHold: 'behind' as const,
    };
    const work = resolveRequestTracks(base({ inflight: [draftTurn, sibling, closingTurn] }))[1];
    expect(work).toMatchObject({ state: 'working', line: { doing: 'is drafting the invoices' } });
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

  // The runtime's pause card is filed as a question, and the tracker used to
  // say "has a question for you" over work that had simply stopped.
  it('says the work stopped, not that it has a question, when the runtime paused it', () => {
    const paused = { ...invoices, status: 'paused' } as Task;
    const card = {
      id: 'q2',
      projectId: 'bakery',
      gezelId: 'mees',
      sessionId: '',
      taskRef: 'bakery/1',
      prompt: '"Invoices" stopped.',
      createdAt: T(27),
      intent: { kind: 'task-paused', taskRef: 'bakery/1', stepId: 'draft', reason: 'step_stalled' },
    } as Question;
    const work = resolveRequestTracks(
      base({
        tasks: [paused, invoiceShard, priceList],
        inflight: [closingTurn],
        questions: [card],
      }),
    )[1];
    expect(work).toMatchObject({
      state: 'needs-you',
      line: { doing: 'stopped before this was finished' },
      paused: { taskRef: 'bakery/1', reason: 'step_stalled' },
      questionIds: ['q2'],
    });
  });

  it('waits for the person to go on when they stopped it themselves', () => {
    const paused = { ...invoices, status: 'paused' } as Task;
    const work = resolveRequestTracks(
      base({ tasks: [paused, invoiceShard, priceList], inflight: [closingTurn] }),
    )[1];
    expect(work).toMatchObject({
      state: 'needs-you',
      line: { doing: 'is waiting for you to go on' },
      paused: { taskRef: 'bakery/1' },
    });
    expect(work?.paused?.reason).toBeUndefined();
  });

  it('never moves back a stop when a review sends the work back', () => {
    const looped = structuredClone(invoices) as Task;
    looped.craftbook.steps[2]!.completedAt = T(25);
    const work = resolveRequestTracks(base({ tasks: [looped], inflight: [draftTurn] }))[0];
    expect(work?.key).toBe(`mees-thread@${T(0)}`);
    expect(work?.stop).toBe('checking');
  });

  it('reads a review round under way as checking the work', () => {
    const reviewing = structuredClone(invoices) as Task;
    const draft = reviewing.craftbook.steps.find((s) => s.id === reviewing.activeStepId)!;
    draft.outcomeReviewRounds = 1;
    const work = resolveRequestTracks(base({ tasks: [reviewing], inflight: [draftTurn] }))[0];
    expect(work?.stop).toBe('checking');
    expect(work?.line?.doing).toMatch(/^is checking (your|the work)/);
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

  // 2026-11-09: crew hired mid-request were introduced only inside the
  // tracker's closed "Who's helping?".
  it('names who joined the crew for the request, from its thread introductions', () => {
    const intro = (taskRef: string, gezelId: string, at: string) => ({
      role: 'assistant' as const,
      at,
      content: `${gezelId} joined.`,
      synthetic: 'crew-introduction' as const,
      crewIntroduction: {
        taskRef,
        moment: 'joined' as const,
        members: [{ gezelId, name: gezelId }],
      },
    });
    const thread: RequestThread = {
      ...meesterThread,
      messages: [
        ...meesterThread.messages,
        intro('bakery/1', 'aditya', T(3)),
        intro('bakery/1', 'aditya', T(4)),
        intro('bakery/1', 'dejan', T(5)),
        intro('bakery/2', 'noor', T(21)),
        {
          role: 'assistant',
          at: T(6),
          content: 'Your crew.',
          synthetic: 'crew-introduction',
          crewIntroduction: {
            taskRef: 'bakery/1',
            moment: 'kickoff',
            members: [{ gezelId: 'sanne', name: 'Sanne' }],
          },
        },
      ],
    };
    const [prices, work] = resolveRequestTracks(base({ threads: new Map([[thread.id, thread]]) }));
    expect(work?.joined).toEqual(['aditya']);
    expect(prices?.joined).toEqual(['noor']);
    expect(resolveRequestTracks(base())[1]?.joined).toBeUndefined();
  });
});

// 2026-11-17: a solo project's Builder was credited with a Reviewer's whole
// pull request review, the Reviewer was listed as helping on their own task,
// and the line read a merge step's name while fifteen batch reviews ran.
describe('resolveRequestTracks on a solo project that handed a task to a specialist', () => {
  const step = (id: string, over: Partial<Task['craftbook']['steps'][number]> = {}) =>
    ({ id, name: id, createdAt: T(0), ...over }) as Task['craftbook']['steps'][number];
  const review = {
    ...invoices,
    projectId: 'docblocks',
    num: 1,
    ref: 'docblocks/1',
    title: 'Pull Request Review',
    assignee: { kind: 'gezel', gezelId: 'koray' },
    activeStepId: 'collect',
    requestRef: { sessionId: 'hieu-thread', at: T(0), messageId: 'p1' },
    launchSessionId: 'hieu-thread',
    craftbook: {
      id: 'pull-request-review',
      name: 'Pull Request Review',
      entryStepId: 'scope',
      steps: [
        step('scope', { name: 'Map the pull request corpus', next: 'scan', completedAt: T(1) }),
        step('scan', {
          name: 'Fan the batches out to the review crew',
          next: 'collect',
          spawnFanout: true,
          completedAt: T(2),
        }),
        step('collect', { name: 'Merge the batch ledgers', next: 'report', lastActivatedAt: T(2) }),
        step('report', { name: 'Synthesize the review', terminal: true }),
      ],
    },
  } as Task;
  const batch = (num: number, status: Task['status'] = 'active') =>
    ({
      ...review,
      num,
      ref: `docblocks/${num}`,
      title: `Review batch ${num}`,
      status,
      parentTaskRef: 'docblocks/1',
      activeStepId: 'review',
      craftbook: {
        id: 'batch',
        name: 'Batch',
        entryStepId: 'review',
        steps: [step('review', { name: 'Review the batch', terminal: true })],
      },
    }) as Task;
  const hieuThread: RequestThread = {
    id: 'hieu-thread',
    gezelId: 'hieu',
    projectId: 'docblocks',
    messages: [{ id: 'p1', role: 'user', at: T(0), content: 'Review pull request 58' }],
  };
  const solo = (over: Partial<RequestTrackInput> = {}) =>
    resolveRequestTracks({
      tasks: [review, batch(2), batch(3)],
      threads: new Map([[hieuThread.id, hieuThread]]),
      inflight: [
        {
          sessionId: 'batch-2',
          gezelId: 'koray',
          projectId: 'docblocks',
          taskRef: 'docblocks/2',
          userText: 'Review the batch',
          startedAt: Date.parse(T(3)),
        },
      ],
      waiting: [],
      questions: [],
      leadOf: () => 'hieu',
      soloOf: () => true,
      estimates: stepDurationEstimates([]),
      now: NOW,
      ...over,
    })[0];

  it('names who holds the work, and never lists them as helping', () => {
    expect(solo()).toMatchObject({
      leadGezelId: 'koray',
      line: { gezelId: 'koray' },
      crew: [],
      parts: { done: 0, total: 2 },
    });
  });

  it('keeps the main gezel speaking when they hold part of it', () => {
    const shared = {
      ...review,
      craftbook: {
        ...review.craftbook,
        steps: review.craftbook.steps.map((s) =>
          s.id === 'report' ? { ...s, assignee: { kind: 'gezel', gezelId: 'hieu' } } : s,
        ),
      },
    } as Task;
    expect(solo({ tasks: [shared, batch(2)] })).toMatchObject({
      leadGezelId: 'hieu',
      crew: ['koray'],
    });
  });

  it('keeps a crew lead speaking for a task they handed out', () => {
    expect(solo({ soloOf: () => false })).toMatchObject({ leadGezelId: 'hieu', crew: ['koray'] });
  });

  it('says the work is in parts, not the waiting step’s name, while the parts run', () => {
    expect(solo()?.line?.doing).toBe('is working through it in parts');
    const back = solo({ tasks: [review, batch(2, 'complete'), batch(3, 'complete')] });
    expect(back?.line?.doing).toBe('is merging the batch ledgers');
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
