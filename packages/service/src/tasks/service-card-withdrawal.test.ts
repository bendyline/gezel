import type { Question, Task } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import {
  serviceCardIsStale,
  withdrawStaleServiceCards,
  withdrawStaleServiceCardsEverywhere,
} from './service-card-withdrawal.js';

const task = (over: Partial<Task> = {}): Task =>
  ({
    ref: 'p/1',
    projectId: 'p',
    status: 'active',
    activeStepId: 'review',
    craftbook: { steps: [{ id: 'draft' }, { id: 'review' }] },
    ...over,
  }) as unknown as Task;

const pauseCard = (over: Partial<Question> = {}): Question => ({
  id: 'pause',
  projectId: 'p',
  gezelId: '',
  sessionId: '',
  prompt: 'Task p/1 paused for help.',
  taskRef: 'p/1',
  intent: { kind: 'task-paused', taskRef: 'p/1', stepId: 'review', reason: 'gate_exhausted' },
  createdAt: '2026-10-26T10:00:00Z',
  ...over,
});

const ownerCard = (over: Partial<Question> = {}): Question => ({
  id: 'owner',
  projectId: 'p',
  gezelId: '',
  sessionId: '',
  prompt: '**Review** is waiting for you.',
  choices: ['Approve'],
  taskRef: 'p/1',
  intent: { kind: 'step-awaits-owner', taskRef: 'p/1', stepId: 'review' },
  createdAt: '2026-10-26T10:00:00Z',
  ...over,
});

function fakeStore(initial: Question[]) {
  const state = { questions: initial.map((q) => ({ ...q })), rewrites: 0 };
  return {
    state,
    store: {
      listProjectQuestions: async () => state.questions.map((q) => ({ ...q })),
      updateProjectQuestions: async (_projectId: string, change: (q: Question[]) => boolean) => {
        const copy = state.questions.map((q) => ({ ...q }));
        if (change(copy)) {
          state.questions = copy;
          state.rewrites += 1;
        }
      },
    },
  };
}

describe('serviceCardIsStale', () => {
  it('keeps a pause card while the task is paused, and withdraws it after', () => {
    expect(serviceCardIsStale(pauseCard(), task({ status: 'paused' }))).toBe(false);
    for (const status of ['active', 'complete', 'canceled'] as const) {
      expect(serviceCardIsStale(pauseCard(), task({ status }))).toBe(true);
    }
  });

  it('keeps an owner card while its step is the one waiting', () => {
    expect(serviceCardIsStale(ownerCard(), task())).toBe(false);
    expect(serviceCardIsStale(ownerCard(), task({ status: 'paused' }))).toBe(false);
  });

  it('withdraws an owner card once the step moved on or the task settled', () => {
    expect(serviceCardIsStale(ownerCard(), task({ activeStepId: 'draft' }))).toBe(true);
    expect(serviceCardIsStale(ownerCard(), task({ status: 'complete' }))).toBe(true);
    expect(serviceCardIsStale(ownerCard(), task({ status: 'canceled' }))).toBe(true);
  });

  it("always withdraws a CLI workflow's owner card: its module owns the step", () => {
    const driven = task({
      craftbook: { steps: [{ id: 'review' }], cliWorkflow: { module: 'batch.mjs' } },
    } as Partial<Task>);
    expect(serviceCardIsStale(ownerCard(), driven)).toBe(true);
  });

  it('leaves answered cards, session questions and other tasks alone', () => {
    const done = task({ status: 'complete' });
    expect(serviceCardIsStale(ownerCard({ answer: { selectedChoices: [0], at: 'x' } }), done)).toBe(
      false,
    );
    expect(serviceCardIsStale(ownerCard({ sessionId: 's1' }), done)).toBe(false);
    expect(
      serviceCardIsStale(
        ownerCard({ intent: { kind: 'step-awaits-owner', taskRef: 'p/2', stepId: 'review' } }),
        done,
      ),
    ).toBe(false);
    expect(serviceCardIsStale({ ...pauseCard(), intent: undefined }, done)).toBe(false);
  });
});

describe('withdrawStaleServiceCards', () => {
  it('closes the stale cards silently in one rewrite and announces each', async () => {
    const { state, store } = fakeStore([
      pauseCard(),
      ownerCard(),
      pauseCard({
        id: 'other',
        taskRef: 'p/2',
        intent: { kind: 'task-paused', taskRef: 'p/2', reason: 'gate_exhausted' },
      }),
    ]);
    const events: unknown[] = [];
    const count = await withdrawStaleServiceCards(
      { store, chatEvents: { publishProjectEvent: (_p, event) => events.push(event) } },
      task({ status: 'complete' }),
    );
    expect(count).toBe(2);
    expect(state.rewrites).toBe(1);
    const byId = Object.fromEntries(state.questions.map((q) => [q.id, q]));
    expect(byId.pause?.answer).toMatchObject({ silentSkip: true, withdrawn: true });
    expect(byId.owner?.answer).toMatchObject({ silentSkip: true, withdrawn: true });
    expect(byId.other?.answer).toBeUndefined();
    expect(events).toHaveLength(2);
  });

  it('does not rewrite the file when nothing is stale', async () => {
    const { state, store } = fakeStore([ownerCard()]);
    const count = await withdrawStaleServiceCards(
      { store, chatEvents: { publishProjectEvent: () => {} } },
      task(),
    );
    expect(count).toBe(0);
    expect(state.rewrites).toBe(0);
  });
});

describe('withdrawStaleServiceCardsEverywhere', () => {
  it('withdraws by each task as it stands, and keeps cards whose task cannot be read', async () => {
    const { state, store } = fakeStore([
      pauseCard({ id: 'done-pause' }),
      ownerCard({
        id: 'unreadable',
        taskRef: 'p/9',
        intent: { kind: 'step-awaits-owner', taskRef: 'p/9', stepId: 'review' },
      }),
      ownerCard({
        id: 'waiting',
        taskRef: 'p/3',
        intent: { kind: 'step-awaits-owner', taskRef: 'p/3', stepId: 'review' },
      }),
    ]);
    const tasks: Record<number, Task> = {
      1: task({ status: 'complete' }),
      3: task({ ref: 'p/3' }),
    };
    const count = await withdrawStaleServiceCardsEverywhere({
      store,
      chatEvents: { publishProjectEvent: () => {} },
      listProjectIds: async () => ['p'],
      readTask: async (_projectId, num) => {
        if (num === 9) throw new Error('EIO');
        return tasks[num] ?? null;
      },
    });
    expect(count).toBe(1);
    const pending = state.questions.filter((q) => !q.answer).map((q) => q.id);
    expect(pending.sort()).toEqual(['unreadable', 'waiting']);
  });
});
