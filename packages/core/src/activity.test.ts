import { describe, expect, it } from 'vitest';
import { type ActivityTurn, resolveActivity } from './activity.js';
import type { Question } from './schemas/question.js';
import type { QueueStatusResponse } from './schemas/queue-status.js';
import type { Task, TaskWaitReason } from './schemas/task.js';

const at = '2026-10-02T12:00:00.000Z';
function task(overrides: Partial<Task> = {}): Task {
  return {
    projectId: 'shop',
    num: 1,
    ref: 'shop/1',
    title: 'Autumn newsletter',
    status: 'active',
    assignee: { kind: 'gezel', gezelId: 'maya' },
    activeStepId: 'write',
    craftbook: {
      id: 'newsletter',
      title: 'Newsletter',
      steps: [{ id: 'write', name: 'Write', createdAt: at }],
    },
    createdAt: at,
    updatedAt: at,
    ...overrides,
  } as Task;
}
function queues(): QueueStatusResponse {
  return {
    providers: {},
    sessions: [],
    cache: [],
    at,
    taskRunner: { pendingCount: 0, pendingByGezel: {}, pendingByProject: {} },
  };
}
const turn: ActivityTurn = {
  sessionId: 'session-1',
  projectId: 'shop',
  gezelId: 'maya',
  taskRef: 'shop/1',
  userText: 'Write the newsletter',
  startedAt: Date.parse(at),
  lastProgressAgoMs: 100,
};
const question: Question = {
  id: 'q1',
  projectId: 'shop',
  gezelId: 'maya',
  sessionId: 'session-1',
  taskRef: 'shop/1',
  prompt: 'Which offer?',
  createdAt: at,
};
function resolve(overrides: Partial<Parameters<typeof resolveActivity>[0]> = {}) {
  return resolveActivity({
    tasks: [task()],
    waiting: [],
    questions: [],
    inflight: [],
    queues: queues(),
    ...overrides,
  });
}

describe('Activity reflects execution rather than task lifecycle', () => {
  it('does not claim that an active task is running without runtime evidence', () => {
    expect(resolve().items).toMatchObject([
      { id: 'task:shop/1', section: 'next', detail: expect.stringContaining('Not running') },
    ]);
  });
  it.each<[TaskWaitReason, string, string]>([
    ['dispatching', 'working', 'Starting'],
    ['provider-busy', 'next', 'other work'],
    ['engagement-off', 'next', 'off'],
    ['engagement-paused', 'next', 'paused'],
    ['night-shift', 'next', 'Night Shift'],
    ['night-quota', 'next', 'quota'],
  ])('explains %s honestly', (reason, section, text) => {
    const result = resolve({ waiting: [{ ref: 'shop/1', gezelId: 'maya', reason, since: at }] });
    expect(result.items[0]).toMatchObject({ section, detail: expect.stringContaining(text) });
  });
  it('counts a task, its handoff, live turn and provider slot once', () => {
    const queue = queues();
    queue.providers.openai = {
      running: 1,
      queuedInteractive: 0,
      queuedBackground: 0,
      concurrency: 1,
      active: [{ sessionId: turn.sessionId, runningForMs: 10 }],
      pending: [],
    };
    const result = resolve({
      queues: queue,
      inflight: [turn],
      waiting: [
        {
          ref: 'shop/1',
          gezelId: 'maya',
          reason: 'dispatching',
          since: at,
          sessionId: turn.sessionId,
        },
      ],
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ section: 'working', title: 'Autumn newsletter' });
  });
  it('a provider wait is not presented as work running', () => {
    const queue = queues();
    queue.providers.openai = {
      running: 0,
      queuedInteractive: 1,
      queuedBackground: 0,
      concurrency: 1,
      active: [],
      pending: [{ sessionId: turn.sessionId, id: 1, lane: 'interactive', waitedMs: 10 }],
    };
    expect(resolve({ queues: queue, inflight: [turn] }).items).toMatchObject([{ section: 'next' }]);
  });
  it('joins a provider slot to its task even between conversation lifecycle events', () => {
    const queue = queues();
    queue.providers.openai = {
      running: 1,
      queuedInteractive: 0,
      queuedBackground: 0,
      concurrency: 1,
      active: [{ sessionId: turn.sessionId, runningForMs: 10 }],
      pending: [],
    };
    const result = resolve({
      queues: queue,
      sessionOwners: [
        { sessionId: turn.sessionId, projectId: 'shop', gezelId: 'maya', taskRef: 'shop/1' },
      ],
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ id: 'task:shop/1', section: 'working' });
  });
  it('reconciles a starting handoff with its actual provider wait', () => {
    const queue = queues();
    queue.providers.openai = {
      running: 0,
      queuedInteractive: 1,
      queuedBackground: 0,
      concurrency: 1,
      active: [],
      pending: [{ sessionId: turn.sessionId, id: 1, lane: 'interactive', waitedMs: 10 }],
    };
    const result = resolve({
      queues: queue,
      waiting: [
        {
          ref: 'shop/1',
          gezelId: 'maya',
          reason: 'dispatching',
          since: at,
          sessionId: turn.sessionId,
        },
      ],
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      section: 'next',
      detail: 'Waiting for a free model slot.',
    });
  });
  it('keeps a future recurring run under Next and out of the working count', () => {
    const recurring = task({
      cron: { expression: '0 22 * * *', nextTickAt: '2026-10-02T22:00:00Z' },
    });
    recurring.spawnsCraftbook = recurring.craftbook;
    expect(resolve({ tasks: [recurring] }).items[0]).toMatchObject({
      section: 'next',
      detail: 'Scheduled · 2026-10-02T22:00:00Z',
      scheduled: true,
    });
  });
  it.each<[TaskWaitReason, boolean]>([
    ['night-shift', true],
    ['night-quota', true],
    ['provider-busy', false],
    ['engagement-paused', false],
  ])('marks work parked by %s as scheduled: %s', (reason, scheduled) => {
    const result = resolve({ waiting: [{ ref: 'shop/1', gezelId: 'maya', reason, since: at }] });
    expect(Boolean(result.items[0]?.scheduled)).toBe(scheduled);
  });
  it('a scheduled task that reaches the engine is no longer scheduled', () => {
    const waiting = [
      {
        ref: 'shop/1',
        gezelId: 'maya',
        reason: 'night-shift' as const,
        since: at,
        sessionId: turn.sessionId,
      },
    ];
    const queue = queues();
    queue.providers.openai = {
      running: 0,
      queuedInteractive: 0,
      queuedBackground: 1,
      concurrency: 1,
      active: [],
      pending: [{ sessionId: turn.sessionId, id: 1, lane: 'background', waitedMs: 10 }],
    };
    expect(resolve({ waiting, queues: queue }).items).toMatchObject([
      { section: 'next', detail: 'Waiting for a free model slot.', scheduled: false },
    ]);
    expect(resolve({ waiting, inflight: [turn] }).items).toMatchObject([
      { section: 'working', scheduled: false },
    ]);
  });
  it('a question waiting inside a live approval turn takes precedence', () => {
    const result = resolve({ inflight: [turn], questions: [question] });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ section: 'needs-you', questionIds: ['q1'] });
  });
  it('uses the current step owner rather than the task entry owner', () => {
    const owned = task();
    owned.craftbook.steps[0]!.assignee = { kind: 'user' };
    expect(resolve({ tasks: [owned] }).items[0]).toMatchObject({
      section: 'needs-you',
      detail: 'Current step: Write. Waiting for your direction.',
    });
    owned.assignee = { kind: 'user' };
    delete owned.craftbook.steps[0]!.assignee;
    expect(resolve({ tasks: [owned] }).items[0]?.detail).toBe(
      'Current step: Write. Waiting for your direction.',
    );
  });
  it('separates finished work from questions and keeps an unrelated live turn visible', () => {
    const ready: Question = {
      ...question,
      id: 'ready',
      intent: { kind: 'task-finished', taskRef: 'shop/1' },
    } as Question;
    const result = resolve({
      tasks: [task({ status: 'complete' })],
      questions: [ready],
      inflight: [turn],
    });
    expect(result.items.map((item) => item.section)).toEqual(['working', 'ready']);
  });
  it('omits paused, inherited-paused, draft, and finished tasks', () => {
    expect(resolve({ tasks: [task({ status: 'paused' })] }).items).toEqual([]);
    expect(resolve({ tasks: [task({ effectiveStatus: 'paused' })] }).items).toEqual([]);
    for (const status of ['draft', 'complete', 'canceled'] as const)
      expect(resolve({ tasks: [task({ status })] }).items).toEqual([]);
  });
  it('omits tasks in a paused project', () => {
    const shelved = task();
    expect(
      resolve({ tasks: [shelved], inactiveProjectIds: new Set([shelved.projectId]) }).items,
    ).toEqual([]);
  });
  it('keeps a paused task visible while its live turn is still running', () => {
    expect(resolve({ tasks: [task({ status: 'paused' })], inflight: [turn] }).items).toEqual([
      expect.objectContaining({
        section: 'working',
        taskRef: turn.taskRef,
        title: 'Autumn newsletter',
      }),
    ]);
  });
  it('shows pending messages without counting them as extra working jobs', () => {
    const queue = queues();
    queue.sessions = [
      { sessionId: turn.sessionId, depth: 2, entries: [], nextPreview: 'Also include Saturday' },
    ];
    const result = resolve({ queues: queue, inflight: [turn] });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.detail).toContain('2 messages waiting');
    expect(resolve({ tasks: [], queues: queue }).items[0]?.section).toBe('next');
  });
});

describe('Activity shows one row per request', () => {
  it("folds the bakery's tasks, shard, sessions and receipt into two rows", async () => {
    const { resolveRequestTracks } = await import('./request-track/resolve.js');
    const { stepDurationEstimates } = await import('./request-track/eta.js');
    const bakery = await import('./request-track/fixtures/bakery.js');
    const receipt: Question = {
      id: 'ready-2',
      projectId: 'default',
      gezelId: 'mees',
      sessionId: 'mees-thread',
      taskRef: 'bakery/2',
      prompt: '**Price list** is finished.',
      intent: { kind: 'task-finished', taskRef: 'bakery/2' },
      createdAt: bakery.T(28),
    };
    const tasks = [bakery.invoices, bakery.invoiceShard, bakery.priceList];
    const inflight = [bakery.draftTurn, bakery.closingTurn];
    const waiting = [
      { ref: 'bakery/4', reason: 'provider-busy' as const, gezelId: 'aditya', since: bakery.T(26) },
    ];
    const requests = resolveRequestTracks({
      tasks,
      threads: new Map([[bakery.meesterThread.id, bakery.meesterThread]]),
      inflight,
      waiting,
      questions: [receipt],
      leadOf: (projectId) => (projectId === 'bakery' ? 'dejan' : 'mees'),
      estimates: stepDurationEstimates([]),
      now: bakery.NOW,
    });
    const shared = { tasks, inflight, waiting, questions: [receipt], queues: queues() };
    // Without requests: a working task, a waiting shard, a live thread and a receipt.
    expect(resolveActivity(shared).items.length).toBeGreaterThanOrEqual(4);

    const { items, requests: live } = resolveActivity({ ...shared, requests });
    expect(items.map((i) => [i.id, i.section])).toEqual(
      expect.arrayContaining([
        [`request:mees-thread@${bakery.T(0)}`, 'working'],
        [`request:mees-thread@${bakery.T(20)}`, 'ready'],
      ]),
    );
    expect(items).toHaveLength(2);
    const working = items.find((i) => i.section === 'working');
    expect(working).toMatchObject({
      title: 'Make my October invoices for the three cafe clients',
      gezelId: 'dejan',
      sessionId: 'mees-thread',
    });
    expect(working?.detail).toMatch(/^Drafting the invoices\. First time here: about/);
    expect(items.find((i) => i.section === 'ready')?.questionIds).toEqual(['ready-2']);
    expect(live?.map((r) => r.state)).toEqual(['ready', 'working']);
  });
});
