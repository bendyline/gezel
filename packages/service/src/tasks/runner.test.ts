import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TaskCraftbook, TaskCraftbookStep } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../fs/store.js';
import { ProviderQueue } from '../providers/queue.js';
import type { LLMProvider, ProviderName } from '../providers/types.js';
import { TaskManager } from './manager.js';
import type { QuotaReserveHold } from './night-quota-gate.js';
import { TaskRunner } from './runner.js';

/** Build a fixture craftbook from inline step records — keeps tests terse. */
function fixtureCraftbook(steps: TaskCraftbookStep[]): TaskCraftbook {
  const now = new Date().toISOString();
  return {
    id: 'cb-test',
    name: 'test',
    steps,
    entryStepId: steps[0]!.id,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Minimal stand-in for ChatManager + provider registry that
 * TaskRunner depends on. Records dispatches for assertion.
 */
class FakeDispatcher {
  readonly dispatches: Array<{
    gezelId: string;
    projectId: string;
    taskRef: string;
    stepId: string;
    lane?: 'interactive' | 'background';
    nightShift?: boolean;
    kind?: 'handoff' | 'entry' | 'retry';
    roleBasedNameOnlyMode?: boolean;
    capabilityFloor?: string;
    bookCatalogId?: string;
    resumeExisting?: boolean;
  }> = [];
  readonly providers = new Map<ProviderName, LLMProvider>();
  readonly activeSessionIds = new Set<string>();
  readonly cancelledSessionIds: string[] = [];
  ensureProvider?: (name: ProviderName) => Promise<LLMProvider>;

  constructor(
    private readonly gezelProvider: Map<string, ProviderName>,
    private readonly beforeDispatch?: () => Promise<void>,
  ) {}

  async startHandoffSession(args: {
    gezelId: string;
    projectId: string;
    taskRef: string;
    stepId: string;
    fromGezelName?: string;
    lane?: 'interactive' | 'background';
    nightShift?: boolean;
    kind?: 'handoff' | 'entry' | 'retry';
    roleBasedNameOnlyMode?: boolean;
    capabilityFloor?: string;
    bookCatalogId?: string;
    resumeExisting?: boolean;
  }): Promise<{ sessionId: string }> {
    await this.beforeDispatch?.();
    this.dispatches.push({
      gezelId: args.gezelId,
      projectId: args.projectId,
      taskRef: args.taskRef,
      stepId: args.stepId,
      ...(args.lane ? { lane: args.lane } : {}),
      ...(args.nightShift ? { nightShift: true } : {}),
      ...(args.kind ? { kind: args.kind } : {}),
      ...(args.roleBasedNameOnlyMode !== undefined
        ? { roleBasedNameOnlyMode: args.roleBasedNameOnlyMode }
        : {}),
      ...(args.capabilityFloor ? { capabilityFloor: args.capabilityFloor } : {}),
      ...(args.bookCatalogId ? { bookCatalogId: args.bookCatalogId } : {}),
      ...(args.resumeExisting ? { resumeExisting: true } : {}),
    });
    // In production, startHandoffSession returns before the async
    // send actually acquires a queue slot. Mirror that — don't
    // acquire here. Tests simulate slot pressure manually via
    // queue.acquire() on the setup path.
    const sessionId = `session-${this.dispatches.length}`;
    this.activeSessionIds.add(sessionId);
    return { sessionId };
  }

  async cancelHandoffSession(sessionId: string): Promise<{ cancelled: boolean }> {
    const cancelled = this.activeSessionIds.delete(sessionId);
    if (cancelled) this.cancelledSessionIds.push(sessionId);
    return { cancelled };
  }

  isHandoffSessionActive(sessionId: string): boolean {
    return this.activeSessionIds.has(sessionId);
  }

  async resolveProviderName(
    gezelId: string,
    _opts?: { nightShift?: boolean },
  ): Promise<ProviderName> {
    return this.gezelProvider.get(gezelId) ?? 'copilot';
  }

  getProvider(name: ProviderName): LLMProvider | null {
    return this.providers.get(name) ?? null;
  }

  setProvider(name: ProviderName, queue: ProviderQueue): void {
    this.providers.set(name, {
      name,
      initialize: async () => {},
      shutdown: async () => {},
      createSession: async () => {
        throw new Error('not used in runner tests');
      },
      listModels: async () => [],
      queue,
    });
  }
}

let home: string;
let store: Store;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-runner-test-'));
  store = new Store({ home });
  await store.ensureLayout();
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('TaskRunner — dispatch + FIFO', () => {
  it('preserves a handoff enqueued while a serialized tick is in flight', async () => {
    await store.createProject({ name: 'p1' });
    await store.createGezel({ name: 'Bea' });
    const now = new Date().toISOString();
    for (const num of [1, 2]) {
      await store.writeTask({
        projectId: 'p1',
        num,
        ref: `p1/${num}`,
        title: `t${num}`,
        status: 'active',
        assignee: { kind: 'gezel', gezelId: 'bea' },
        craftbook: fixtureCraftbook([
          {
            id: 'plan',
            name: 'plan',
            assignee: { kind: 'gezel', gezelId: 'bea' },
            createdAt: now,
          },
        ]),
        activeStepId: 'plan',
        createdAt: now,
        updatedAt: now,
        createdBy: { kind: 'user' },
      });
    }

    let markDispatchStarted!: () => void;
    const dispatchStarted = new Promise<void>((resolve) => {
      markDispatchStarted = resolve;
    });
    let releaseDispatch!: () => void;
    const dispatchGate = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });
    const dispatcher = new FakeDispatcher(new Map([['bea', 'copilot']]), async () => {
      markDispatchStarted();
      await dispatchGate;
    });
    dispatcher.setProvider('copilot', new ProviderQueue({ concurrency: 10 }));
    const runner = new TaskRunner({ store, dispatcher });

    runner.enqueueHandoff({ taskRef: 'p1/1', stepId: 'plan', gezelId: 'bea', projectId: 'p1' });
    const tick = runner.wake();
    await dispatchStarted;

    // This mirrors an entry handoff arriving just after the interval tick's
    // snapshot. It must survive that pass and retain FIFO position.
    runner.enqueueHandoff({ taskRef: 'p1/2', stepId: 'plan', gezelId: 'bea', projectId: 'p1' });
    releaseDispatch();
    await tick;

    expect(dispatcher.dispatches.map((dispatch) => dispatch.taskRef)).toEqual(['p1/1']);
    expect(runner.workSnapshot().queuedTaskRefs).toEqual(['p1/2']);

    await runner.tick();
    expect(dispatcher.dispatches.map((dispatch) => dispatch.taskRef)).toEqual(['p1/1', 'p1/2']);
  });

  it('deduplicates the same task activation before and after dispatch', async () => {
    await store.createProject({ name: 'p1' });
    await store.createGezel({ name: 'Bea' });
    const activatedAt = new Date().toISOString();
    await store.writeTask({
      projectId: 'p1',
      num: 1,
      ref: 'p1/1',
      title: 't',
      status: 'active',
      assignee: { kind: 'gezel', gezelId: 'bea' },
      craftbook: fixtureCraftbook([
        {
          id: 'plan',
          name: 'plan',
          assignee: { kind: 'gezel', gezelId: 'bea' },
          lastActivatedAt: activatedAt,
          createdAt: activatedAt,
        },
      ]),
      activeStepId: 'plan',
      createdAt: activatedAt,
      updatedAt: activatedAt,
      createdBy: { kind: 'user' },
    });
    const dispatcher = new FakeDispatcher(new Map([['bea', 'copilot']]));
    dispatcher.setProvider('copilot', new ProviderQueue({ concurrency: 10 }));
    const runner = new TaskRunner({ store, dispatcher });
    const handoff = {
      taskRef: 'p1/1',
      stepId: 'plan',
      gezelId: 'bea',
      projectId: 'p1',
      activationAt: activatedAt,
    };

    runner.enqueueHandoff(handoff);
    runner.enqueueHandoff(handoff);
    expect(runner.snapshot().pendingCount).toBe(1);
    await runner.tick();
    expect(dispatcher.dispatches).toHaveLength(1);

    runner.enqueueHandoff(handoff);
    await runner.tick();
    expect(dispatcher.dispatches).toHaveLength(1);
    expect(runner.snapshot().pendingCount).toBe(0);
  });

  it('dispatches each enqueued handoff on tick', async () => {
    await store.createProject({ name: 'p1' });
    await store.createGezel({ name: 'Bea' });
    const now = new Date().toISOString();
    await store.writeTask({
      projectId: 'p1',
      num: 1,
      ref: 'p1/1',
      title: 't',
      status: 'active',
      assignee: { kind: 'gezel', gezelId: 'bea' },
      craftbook: fixtureCraftbook([
        { id: 'plan', name: 'plan', assignee: { kind: 'gezel', gezelId: 'bea' }, createdAt: now },
      ]),
      activeStepId: 'plan',
      roleBasedNameOnlyMode: true,
      createdAt: now,
      updatedAt: now,
      createdBy: { kind: 'user' },
    });

    const dispatcher = new FakeDispatcher(new Map([['bea', 'copilot']]));
    dispatcher.setProvider('copilot', new ProviderQueue({ concurrency: 10 }));

    const runner = new TaskRunner({ store, dispatcher, tickIntervalMs: 1000 });
    runner.enqueueHandoff({ taskRef: 'p1/1', stepId: 'plan', gezelId: 'bea', projectId: 'p1' });
    await runner.tick();

    expect(dispatcher.dispatches).toHaveLength(1);
    expect(dispatcher.dispatches[0]?.taskRef).toBe('p1/1');
    expect(dispatcher.dispatches[0]?.lane).toBe('background');
    expect(dispatcher.dispatches[0]?.roleBasedNameOnlyMode).toBe(true);
    expect(runner.snapshot().pendingCount).toBe(0);
  });

  it('prepares an unmarked onEnter step before dispatch', async () => {
    await store.createProject({ name: 'p1' });
    await store.createGezel({ name: 'Bea' });
    const now = new Date().toISOString();
    await store.writeTask({
      projectId: 'p1',
      num: 1,
      ref: 'p1/1',
      title: 't',
      status: 'active',
      assignee: { kind: 'gezel', gezelId: 'bea' },
      craftbook: fixtureCraftbook([
        {
          id: 'plan',
          name: 'plan',
          assignee: { kind: 'gezel', gezelId: 'bea' },
          onEnter: { name: 'prepare', scope: 'standard' },
          lastActivatedAt: now,
          createdAt: now,
        },
      ]),
      activeStepId: 'plan',
      createdAt: now,
      updatedAt: now,
      createdBy: { kind: 'user' },
    });

    const events: string[] = [];
    const dispatcher = new FakeDispatcher(new Map([['bea', 'copilot']]), async () => {
      events.push('dispatch');
    });
    dispatcher.setProvider('copilot', new ProviderQueue({ concurrency: 10 }));
    const prepareActiveStep = vi.fn(async () => {
      events.push('setup');
      const current = (await store.readTask('p1', 1))!;
      const prepared = {
        ...current,
        craftbook: {
          ...current.craftbook,
          steps: current.craftbook.steps.map((step) =>
            step.id === 'plan' ? { ...step, onEnterCompletedAt: now } : step,
          ),
        },
      };
      await store.writeTask(prepared);
      return { status: 'ready' as const, task: prepared };
    });
    const runner = new TaskRunner({ store, dispatcher, prepareActiveStep });

    runner.enqueueHandoff({ taskRef: 'p1/1', stepId: 'plan', gezelId: 'bea', projectId: 'p1' });
    await runner.tick();

    expect(events).toEqual(['setup', 'dispatch']);
    expect(prepareActiveStep).toHaveBeenCalledWith('p1', 1);
    expect(dispatcher.dispatches).toHaveLength(1);
  });

  it('holds off when the provider queue is saturated', async () => {
    await store.createProject({ name: 'p1' });
    await store.createGezel({ name: 'Bea' });
    const now = new Date().toISOString();
    await store.writeTask({
      projectId: 'p1',
      num: 1,
      ref: 'p1/1',
      title: 't',
      status: 'active',
      assignee: { kind: 'gezel', gezelId: 'bea' },
      craftbook: fixtureCraftbook([
        { id: 'plan', name: 'plan', assignee: { kind: 'gezel', gezelId: 'bea' }, createdAt: now },
      ]),
      activeStepId: 'plan',
      createdAt: now,
      updatedAt: now,
      createdBy: { kind: 'user' },
    });

    const dispatcher = new FakeDispatcher(new Map([['bea', 'ollama']]));
    const queue = new ProviderQueue({ concurrency: 1 });
    dispatcher.setProvider('ollama', queue);

    // Simulate the provider being busy: acquire a slot and hold it.
    const release = await queue.acquire({ lane: 'interactive' });

    const runner = new TaskRunner({ store, dispatcher });
    runner.enqueueHandoff({ taskRef: 'p1/1', stepId: 'plan', gezelId: 'bea', projectId: 'p1' });
    await runner.tick();

    expect(dispatcher.dispatches).toHaveLength(0);
    expect(runner.snapshot().pendingCount).toBe(1);

    // Free the slot; next tick dispatches.
    release();
    await runner.tick();
    expect(dispatcher.dispatches).toHaveLength(1);
  });

  it('dispatches up to the provider cap per tick; holds the rest', async () => {
    await store.createProject({ name: 'p1' });
    await store.createGezel({ name: 'Bea' });
    const now = new Date().toISOString();
    for (let i = 1; i <= 5; i++) {
      await store.writeTask({
        projectId: 'p1',
        num: i,
        ref: `p1/${i}`,
        title: `t${i}`,
        status: 'active',
        assignee: { kind: 'gezel', gezelId: 'bea' },
        craftbook: fixtureCraftbook([
          { id: 'plan', name: 'plan', assignee: { kind: 'gezel', gezelId: 'bea' }, createdAt: now },
        ]),
        activeStepId: 'plan',
        createdAt: now,
        updatedAt: now,
        createdBy: { kind: 'user' },
      });
    }

    const dispatcher = new FakeDispatcher(new Map([['bea', 'copilot']]));
    const queue = new ProviderQueue({ concurrency: 3 });
    dispatcher.setProvider('copilot', queue);

    const runner = new TaskRunner({ store, dispatcher });
    for (let i = 1; i <= 5; i++) {
      runner.enqueueHandoff({
        taskRef: `p1/${i}`,
        stepId: 'plan',
        gezelId: 'bea',
        projectId: 'p1',
      });
    }
    // First tick: the runner's in-tick counter lets it dispatch up
    // to `concurrency` handoffs, then holds. `running` stays 0 in
    // this fake because we don't acquire slots on dispatch — just
    // the in-tick count gates.
    await runner.tick();
    expect(dispatcher.dispatches).toHaveLength(3);
    expect(runner.snapshot().pendingCount).toBe(2);
  });

  it('initializes a cold one-slot provider before admitting a 21-batch fanout', async () => {
    await store.createProject({ name: 'p1' });
    await store.createGezel({ name: 'Bea' });
    const now = new Date().toISOString();
    for (let num = 1; num <= 21; num++) {
      await store.writeTask({
        projectId: 'p1',
        num,
        ref: `p1/${num}`,
        title: `PR batch ${num}`,
        status: 'active',
        assignee: { kind: 'gezel', gezelId: 'bea' },
        craftbook: fixtureCraftbook([
          {
            id: 'review',
            name: 'review',
            assignee: { kind: 'gezel', gezelId: 'bea' },
            createdAt: now,
          },
        ]),
        activeStepId: 'review',
        createdAt: now,
        updatedAt: now,
        createdBy: { kind: 'user' },
      });
    }

    const dispatcher = new FakeDispatcher(new Map([['bea', 'llama-cpp']]));
    const initialize = vi.fn(async (name: ProviderName) => {
      dispatcher.setProvider(name, new ProviderQueue({ concurrency: 1 }));
      return dispatcher.getProvider(name)!;
    });
    dispatcher.ensureProvider = initialize;
    const runner = new TaskRunner({ store, dispatcher });
    await runner.rehydrateFromStore({ projectId: 'p1' });
    await runner.tick();

    expect(initialize).toHaveBeenCalledTimes(1);
    expect(dispatcher.dispatches).toHaveLength(1);
    expect(dispatcher.dispatches[0]?.resumeExisting).toBe(true);
    expect(runner.snapshot().pendingCount).toBe(20);
  });

  it('holds restored work at the background cap and preserves foreground headroom', async () => {
    await store.createProject({ name: 'p1' });
    await store.createGezel({ name: 'Bea' });
    const now = new Date().toISOString();
    for (let i = 1; i <= 5; i++) {
      await store.writeTask({
        projectId: 'p1',
        num: i,
        ref: `p1/${i}`,
        title: `t${i}`,
        status: 'active',
        assignee: { kind: 'gezel', gezelId: 'bea' },
        craftbook: fixtureCraftbook([
          { id: 'plan', name: 'plan', assignee: { kind: 'gezel', gezelId: 'bea' }, createdAt: now },
        ]),
        activeStepId: 'plan',
        createdAt: now,
        updatedAt: now,
        createdBy: { kind: 'user' },
      });
    }

    const dispatcher = new FakeDispatcher(new Map([['bea', 'mlx']]));
    dispatcher.setProvider('mlx', new ProviderQueue({ concurrency: 4, backgroundConcurrency: 3 }));
    const runner = new TaskRunner({ store, dispatcher });
    for (let i = 1; i <= 5; i++) {
      runner.enqueueHandoff({
        taskRef: `p1/${i}`,
        stepId: 'plan',
        gezelId: 'bea',
        projectId: 'p1',
      });
    }

    await runner.tick();

    expect(dispatcher.dispatches).toHaveLength(3);
    expect(dispatcher.dispatches.every((dispatch) => dispatch.lane === 'background')).toBe(true);
    expect(runner.snapshot().pendingCount).toBe(2);
  });

  it('eventually drains when the queue reports slots opening up', async () => {
    await store.createProject({ name: 'p1' });
    await store.createGezel({ name: 'Bea' });
    const now = new Date().toISOString();
    await store.writeTask({
      projectId: 'p1',
      num: 1,
      ref: 'p1/1',
      title: 't',
      status: 'active',
      assignee: { kind: 'gezel', gezelId: 'bea' },
      craftbook: fixtureCraftbook([
        { id: 'plan', name: 'plan', assignee: { kind: 'gezel', gezelId: 'bea' }, createdAt: now },
      ]),
      activeStepId: 'plan',
      createdAt: now,
      updatedAt: now,
      createdBy: { kind: 'user' },
    });

    const dispatcher = new FakeDispatcher(new Map([['bea', 'ollama']]));
    const queue = new ProviderQueue({ concurrency: 1 });
    dispatcher.setProvider('ollama', queue);
    // External acquire simulates another gezel mid-turn.
    const release = await queue.acquire({ lane: 'interactive' });

    const runner = new TaskRunner({ store, dispatcher });
    runner.enqueueHandoff({ taskRef: 'p1/1', stepId: 'plan', gezelId: 'bea', projectId: 'p1' });

    await runner.tick();
    expect(dispatcher.dispatches).toHaveLength(0);
    expect(runner.snapshot().pendingCount).toBe(1);

    release();
    await runner.tick();
    expect(dispatcher.dispatches).toHaveLength(1);
    expect(runner.snapshot().pendingCount).toBe(0);
  });
});

describe('TaskRunner — cancellation via task status', () => {
  it('cancels an already-dispatched handoff when the task pauses', async () => {
    await store.createProject({ name: 'p1' });
    await store.createGezel({ name: 'Bea' });
    const activatedAt = new Date().toISOString();
    const task = {
      projectId: 'p1',
      num: 1,
      ref: 'p1/1',
      title: 't',
      status: 'active' as const,
      assignee: { kind: 'gezel' as const, gezelId: 'bea' },
      craftbook: fixtureCraftbook([
        {
          id: 'plan',
          name: 'plan',
          assignee: { kind: 'gezel' as const, gezelId: 'bea' },
          lastActivatedAt: activatedAt,
          createdAt: activatedAt,
        },
      ]),
      activeStepId: 'plan',
      createdAt: activatedAt,
      updatedAt: activatedAt,
      createdBy: { kind: 'user' as const },
    };
    await store.writeTask(task);
    const dispatcher = new FakeDispatcher(new Map([['bea', 'copilot']]));
    dispatcher.setProvider('copilot', new ProviderQueue({ concurrency: 10 }));
    const runner = new TaskRunner({ store, dispatcher });
    runner.enqueueHandoff({
      taskRef: 'p1/1',
      stepId: 'plan',
      gezelId: 'bea',
      projectId: 'p1',
      activationAt: activatedAt,
    });
    await runner.tick();
    expect(dispatcher.dispatches).toHaveLength(1);

    await store.writeTask({ ...task, status: 'paused' });
    await runner.tick();

    expect(dispatcher.cancelledSessionIds).toEqual(['session-1']);
  });

  it('does not cancel a still-in-flight session that completed its own step', async () => {
    await store.createProject({ name: 'p1' });
    await store.createGezel({ name: 'Bea' });
    const activatedAt = new Date().toISOString();
    const task = {
      projectId: 'p1',
      num: 1,
      ref: 'p1/1',
      title: 't',
      status: 'active' as const,
      assignee: { kind: 'gezel' as const, gezelId: 'bea' },
      craftbook: fixtureCraftbook([
        {
          id: 'finish',
          name: 'finish',
          assignee: { kind: 'gezel' as const, gezelId: 'bea' },
          lastActivatedAt: activatedAt,
          createdAt: activatedAt,
        },
      ]),
      activeStepId: 'finish',
      createdAt: activatedAt,
      updatedAt: activatedAt,
      createdBy: { kind: 'user' as const },
    };
    await store.writeTask(task);
    const dispatcher = new FakeDispatcher(new Map([['bea', 'copilot']]));
    dispatcher.setProvider('copilot', new ProviderQueue({ concurrency: 10 }));
    const runner = new TaskRunner({ store, dispatcher });
    runner.enqueueHandoff({
      taskRef: 'p1/1',
      stepId: 'finish',
      gezelId: 'bea',
      projectId: 'p1',
      activationAt: activatedAt,
    });
    await runner.tick();
    expect(dispatcher.dispatches).toHaveLength(1);
    expect(dispatcher.isHandoffSessionActive('session-1')).toBe(true);

    // The worker's own `advance_task_step` drove the task terminal while
    // its turn is still streaming the closing words. The prune must NOT
    // cancel it — that would self-abort a healthy turn.
    await store.writeTask({ ...task, status: 'complete' });
    await runner.tick();
    expect(dispatcher.cancelledSessionIds).toEqual([]);

    // Once the turn finishes on its own, a later tick just retires the
    // tracking entry — still no cancel.
    dispatcher.activeSessionIds.delete('session-1');
    await runner.tick();
    expect(dispatcher.cancelledSessionIds).toEqual([]);
  });

  it('keeps the successor handoff alive when the prior step completion is replayed', async () => {
    await store.createProject({ name: 'p1' });
    await store.createGezel({ name: 'Bea' });
    const dispatcher = new FakeDispatcher(new Map([['bea', 'copilot']]));
    dispatcher.setProvider('copilot', new ProviderQueue({ concurrency: 10 }));
    const runner = new TaskRunner({ store, dispatcher });
    const tasks = new TaskManager(store);
    const task = await tasks.create('p1', {
      title: 'Duplicate advance race',
      assignee: { kind: 'gezel', gezelId: 'bea' },
      steps: [
        { id: 'design', name: 'Design', assignee: { kind: 'gezel', gezelId: 'bea' } },
        { id: 'build', name: 'Build', assignee: { kind: 'gezel', gezelId: 'bea' } },
      ] as never,
    });

    const advanced = await tasks.completeStep('p1', task.num, 'design');
    const originalActivation = advanced.craftbook.steps.find(
      (step) => step.id === 'build',
    )?.lastActivatedAt;
    expect(originalActivation).toBeTruthy();

    runner.enqueueHandoff({
      taskRef: task.ref,
      stepId: 'build',
      gezelId: 'bea',
      projectId: 'p1',
      activationAt: originalActivation!,
    });
    await runner.tick();
    expect(dispatcher.dispatches).toHaveLength(1);
    expect(dispatcher.isHandoffSessionActive('session-1')).toBe(true);

    // This is the exact debug-bundle race: the previous worker emits its
    // successful advance call again after the successor has already started.
    const replayed = await tasks.completeStep('p1', task.num, 'design');
    expect(replayed.craftbook.steps.find((step) => step.id === 'build')?.lastActivatedAt).toBe(
      originalActivation,
    );

    await runner.tick();
    expect(dispatcher.cancelledSessionIds).toEqual([]);
    expect(dispatcher.isHandoffSessionActive('session-1')).toBe(true);
  });

  it('does not cancel a model-owned same-step gate recovery after reactivation', async () => {
    await store.createProject({ name: 'p1' });
    await store.createGezel({ name: 'Bea' });
    const dispatcher = new FakeDispatcher(new Map([['bea', 'copilot']]));
    dispatcher.setProvider('copilot', new ProviderQueue({ concurrency: 10 }));
    const runner = new TaskRunner({ store, dispatcher });
    const tasks = new TaskManager(store);
    let adopted = false;
    tasks.setCurrentTurnStepReactivatedHook(({ task, newStep }) => {
      const gezelId =
        newStep.assignee?.kind === 'gezel' ? newStep.assignee.gezelId : newStep.suggestedGezelId;
      if (!gezelId || !newStep.lastActivatedAt) return;
      adopted =
        runner.adoptActiveDispatchActivation({
          taskRef: task.ref,
          stepId: newStep.id,
          gezelId,
          activationAt: newStep.lastActivatedAt,
        }) || adopted;
    });
    const task = await tasks.create('p1', {
      title: 'Gate recovery',
      description: 'The current model turn repairs a rejected same-step deliverable gate.',
      assignee: { kind: 'gezel', gezelId: 'bea' },
      steps: [
        {
          id: 'scope',
          name: 'Scope',
          assignee: { kind: 'gezel', gezelId: 'bea' },
          gate: {
            at: 'completion',
            checks: [{ kind: 'minBytes', file: 'notes/scope.md', bytes: 120 }],
            onReject: 'scope',
          },
        },
      ] as never,
    });
    const originalActivation = task.craftbook.steps[0]?.lastActivatedAt;
    expect(originalActivation).toBeTruthy();
    if (!originalActivation) return;

    runner.enqueueHandoff({
      taskRef: task.ref,
      stepId: 'scope',
      gezelId: 'bea',
      projectId: 'p1',
      activationAt: originalActivation,
    });
    await runner.tick();
    expect(dispatcher.dispatches).toHaveLength(1);
    expect(dispatcher.isHandoffSessionActive('session-1')).toBe(true);

    const outcome = await tasks.completeStepChecked('p1', task.num, 'scope', undefined, {
      cause: 'model',
    });
    expect(outcome.status).toBe('held');
    expect(adopted).toBe(true);
    const reactivated = await tasks.get('p1', task.num);
    const currentActivation = reactivated?.craftbook.steps[0]?.lastActivatedAt;
    expect(currentActivation).toBeTruthy();
    expect(currentActivation).not.toBe(originalActivation);

    // This is the race from the debug bundle: the pruning tick lands after
    // the gate bumped lastActivatedAt but while the same turn is consuming
    // the rejection. It must leave the live provider call alone.
    await runner.tick();
    expect(dispatcher.cancelledSessionIds).toEqual([]);
    expect(dispatcher.isHandoffSessionActive('session-1')).toBe(true);

    // Re-keying also suppresses a duplicate enqueue for the adopted
    // activation while its original session is still running.
    runner.enqueueHandoff({
      taskRef: task.ref,
      stepId: 'scope',
      gezelId: 'bea',
      projectId: 'p1',
      activationAt: currentActivation!,
    });
    await runner.tick();
    expect(dispatcher.dispatches).toHaveLength(1);

    dispatcher.activeSessionIds.delete('session-1');
    await runner.tick();
    expect(dispatcher.cancelledSessionIds).toEqual([]);
  });

  it('drops handoff when task is paused before dispatch', async () => {
    await store.createProject({ name: 'p1' });
    await store.createGezel({ name: 'Bea' });
    const now = new Date().toISOString();
    const task = {
      projectId: 'p1',
      num: 1,
      ref: 'p1/1',
      title: 't',
      status: 'active' as const,
      assignee: { kind: 'gezel' as const, gezelId: 'bea' },
      craftbook: fixtureCraftbook([
        {
          id: 'plan',
          name: 'plan',
          assignee: { kind: 'gezel' as const, gezelId: 'bea' },
          createdAt: now,
        },
      ]),
      activeStepId: 'plan',
      createdAt: now,
      updatedAt: now,
      createdBy: { kind: 'user' as const },
    };
    await store.writeTask(task);

    const dispatcher = new FakeDispatcher(new Map([['bea', 'copilot']]));
    dispatcher.setProvider('copilot', new ProviderQueue({ concurrency: 10 }));
    const runner = new TaskRunner({ store, dispatcher });
    runner.enqueueHandoff({ taskRef: 'p1/1', stepId: 'plan', gezelId: 'bea', projectId: 'p1' });

    // Flip to paused before the tick runs.
    await store.writeTask({ ...task, status: 'paused' });

    await runner.tick();
    expect(dispatcher.dispatches).toHaveLength(0);
    expect(runner.snapshot().pendingCount).toBe(0);
  });

  it('drops handoff when the active phase has moved on', async () => {
    await store.createProject({ name: 'p1' });
    await store.createGezel({ name: 'Bea' });
    const now = new Date().toISOString();
    const task = {
      projectId: 'p1',
      num: 1,
      ref: 'p1/1',
      title: 't',
      status: 'active' as const,
      assignee: { kind: 'gezel' as const, gezelId: 'bea' },
      craftbook: fixtureCraftbook([
        { id: 'plan', name: 'plan', createdAt: now },
        { id: 'write', name: 'write', createdAt: now },
      ]),
      activeStepId: 'write', // already advanced
      createdAt: now,
      updatedAt: now,
      createdBy: { kind: 'user' as const },
    };
    await store.writeTask(task);

    const dispatcher = new FakeDispatcher(new Map([['bea', 'copilot']]));
    dispatcher.setProvider('copilot', new ProviderQueue({ concurrency: 10 }));
    const runner = new TaskRunner({ store, dispatcher });
    // Enqueue a handoff for the OLD 'plan' phase.
    runner.enqueueHandoff({ taskRef: 'p1/1', stepId: 'plan', gezelId: 'bea', projectId: 'p1' });
    await runner.tick();
    expect(dispatcher.dispatches).toHaveLength(0);
  });
});

describe('TaskRunner — startup rehydration', () => {
  it('enqueues handoffs for active tasks with no open session', async () => {
    await store.createProject({ name: 'p1' });
    await store.createProject({ name: 'p2' });
    await store.createGezel({ name: 'Bea' });
    await store.createGezel({ name: 'Cid' });
    const now = new Date().toISOString();

    await store.writeTask({
      projectId: 'p1',
      num: 1,
      ref: 'p1/1',
      title: 'bea work',
      status: 'active',
      assignee: { kind: 'gezel', gezelId: 'bea' },
      craftbook: fixtureCraftbook([
        { id: 'plan', name: 'plan', assignee: { kind: 'gezel', gezelId: 'bea' }, createdAt: now },
      ]),
      activeStepId: 'plan',
      createdAt: now,
      updatedAt: now,
      createdBy: { kind: 'user' },
    });
    await store.writeTask({
      projectId: 'p2',
      num: 1,
      ref: 'p2/1',
      title: 'cid work',
      status: 'active',
      assignee: { kind: 'gezel', gezelId: 'cid' },
      craftbook: fixtureCraftbook([
        { id: 'plan', name: 'plan', suggestedGezelId: 'cid', createdAt: now },
      ]),
      activeStepId: 'plan',
      createdAt: now,
      updatedAt: now,
      createdBy: { kind: 'user' },
    });
    // Task-level ownership is the fallback for inline system tasks whose
    // single step does not repeat the assignee (the bundled oversight task).
    await store.writeTask({
      projectId: 'p1',
      num: 3,
      ref: 'p1/3',
      title: 'system work',
      status: 'active',
      assignee: { kind: 'gezel', gezelId: 'bea' },
      craftbook: fixtureCraftbook([{ id: 'plan', name: 'plan', createdAt: now }]),
      activeStepId: 'plan',
      createdAt: now,
      updatedAt: now,
      createdBy: { kind: 'user' },
    });
    // A schedule host is active but inert; the scheduler spawns its children.
    await store.writeTask({
      projectId: 'p1',
      num: 4,
      ref: 'p1/4',
      title: 'scheduled host',
      status: 'active',
      assignee: { kind: 'gezel', gezelId: 'bea' },
      craftbook: fixtureCraftbook([{ id: 'wait', name: 'wait', createdAt: now }]),
      activeStepId: 'wait',
      cron: { expression: '* * * * *', nextTickAt: '2099-01-01T00:00:00Z' },
      createdAt: now,
      updatedAt: now,
      createdBy: { kind: 'user' },
    });
    // A completed task — should NOT be rehydrated.
    await store.writeTask({
      projectId: 'p1',
      num: 2,
      ref: 'p1/2',
      title: 'done',
      status: 'complete',
      assignee: { kind: 'gezel', gezelId: 'bea' },
      craftbook: fixtureCraftbook([{ id: 'plan', name: 'plan', createdAt: now }]),
      activeStepId: 'plan',
      createdAt: now,
      updatedAt: now,
      createdBy: { kind: 'user' },
    });

    const dispatcher = new FakeDispatcher(
      new Map([
        ['bea', 'copilot'],
        ['cid', 'openai'],
      ]),
    );
    const runner = new TaskRunner({ store, dispatcher });
    const p1 = await runner.rehydrateFromStore({ projectId: 'p1' });

    expect(p1.taskRefs.sort()).toEqual(['p1/1', 'p1/3']);
    expect(p1.nightShiftTaskRefs).toEqual([]);
    expect(runner.snapshot().pendingCount).toBe(2);

    const p2 = await runner.rehydrateFromStore({ projectId: 'p2' });
    expect(p2.taskRefs).toEqual(['p2/1']);

    expect(runner.snapshot().pendingCount).toBe(3);
    expect(runner.snapshot().pendingByGezel).toEqual({ bea: 2, cid: 1 });
  });

  it('requeues active tasks even when a stale non-archived session exists', async () => {
    await store.createProject({ name: 'p1' });
    const bea = await store.createGezel({ name: 'Bea' });
    const now = new Date().toISOString();

    await store.writeTask({
      projectId: 'p1',
      num: 1,
      ref: 'p1/1',
      title: 't',
      status: 'active',
      assignee: { kind: 'gezel', gezelId: bea.id },
      craftbook: fixtureCraftbook([
        { id: 'plan', name: 'plan', assignee: { kind: 'gezel', gezelId: bea.id }, createdAt: now },
      ]),
      activeStepId: 'plan',
      createdAt: now,
      updatedAt: now,
      createdBy: { kind: 'user' },
    });
    // A prior process created a session for this phase but no process-local
    // turn survives restart. This may be a failed handoff and must not strand
    // the active task forever.
    await store.writeSession({
      version: 1,
      id: 'existing-session',
      gezelId: bea.id,
      projectId: 'p1',
      providerName: 'copilot',
      messages: [],
      title: 'handoff',
      createdAt: now,
      lastActivityAt: now,
      archived: false,
      taskRef: 'p1/1',
      stepId: 'plan',
      providerState: {},
    });

    const dispatcher = new FakeDispatcher(new Map([[bea.id, 'copilot']]));
    const runner = new TaskRunner({ store, dispatcher });
    await runner.rehydrateFromStore({ projectId: 'p1' });
    expect(runner.snapshot().pendingCount).toBe(1);
    expect(runner.workSnapshot().queuedTaskRefs).toEqual(['p1/1']);
  });

  it('can reconcile only night-shift work when a shift opens', async () => {
    await store.createProject({ name: 'p1' });
    const bea = await store.createGezel({ name: 'Bea' });
    const now = new Date().toISOString();
    const writeTask = (num: number, nightShift: boolean) =>
      store.writeTask({
        projectId: 'p1',
        num,
        ref: `p1/${num}`,
        title: `t${num}`,
        status: 'active',
        assignee: { kind: 'gezel' as const, gezelId: bea.id },
        craftbook: fixtureCraftbook([
          {
            id: 'plan',
            name: 'plan',
            assignee: { kind: 'gezel', gezelId: bea.id },
            createdAt: now,
          },
        ]),
        activeStepId: 'plan',
        ...(nightShift ? { nightShift: { enabled: true } } : {}),
        createdAt: now,
        updatedAt: now,
        createdBy: { kind: 'user' as const },
      });
    await writeTask(1, true);
    await writeTask(2, false);

    const runner = new TaskRunner({
      store,
      dispatcher: new FakeDispatcher(new Map([[bea.id, 'copilot']])),
    });
    await runner.rehydrateFromStore({ nightShiftOnly: true });

    expect(runner.workSnapshot().queuedTaskRefs).toEqual(['p1/1']);
  });
});

describe('TaskRunner — engagement mode', () => {
  it('does not dispatch when engagement mode is off; resumes when flipped back', async () => {
    await store.createProject({ name: 'p1' });
    await store.createGezel({ name: 'Bea' });
    const now = new Date().toISOString();
    await store.writeTask({
      projectId: 'p1',
      num: 1,
      ref: 'p1/1',
      title: 't',
      status: 'active',
      assignee: { kind: 'gezel', gezelId: 'bea' },
      craftbook: fixtureCraftbook([
        { id: 'plan', name: 'plan', assignee: { kind: 'gezel', gezelId: 'bea' }, createdAt: now },
      ]),
      activeStepId: 'plan',
      createdAt: now,
      updatedAt: now,
      createdBy: { kind: 'user' },
    });

    const dispatcher = new FakeDispatcher(new Map([['bea', 'copilot']]));
    dispatcher.setProvider('copilot', new ProviderQueue({ concurrency: 10 }));

    const runner = new TaskRunner({ store, dispatcher, tickIntervalMs: 1000 });
    runner.enqueueHandoff({ taskRef: 'p1/1', stepId: 'plan', gezelId: 'bea', projectId: 'p1' });

    await store.writeConfig({ aiEngagementMode: 'off' });
    await runner.tick();
    expect(dispatcher.dispatches).toHaveLength(0);
    expect(runner.snapshot().pendingCount).toBe(1);

    await store.writeConfig({ aiEngagementMode: 'proactive' });
    await runner.tick();
    expect(dispatcher.dispatches).toHaveLength(1);
    expect(runner.snapshot().pendingCount).toBe(0);
  });
});

describe('TaskRunner — night-shift gating + priority', () => {
  async function writeStepTask(num: number, opts: { nightShift?: boolean }): Promise<void> {
    const now = new Date().toISOString();
    await store.writeTask({
      projectId: 'p1',
      num,
      ref: `p1/${num}`,
      title: `t${num}`,
      status: 'active',
      assignee: { kind: 'gezel', gezelId: 'bea' },
      craftbook: fixtureCraftbook([
        { id: 'plan', name: 'plan', assignee: { kind: 'gezel', gezelId: 'bea' }, createdAt: now },
      ]),
      activeStepId: 'plan',
      ...(opts.nightShift ? { nightShift: { enabled: true } } : {}),
      createdAt: now,
      updatedAt: now,
      createdBy: { kind: 'user' },
    });
  }

  it('holds a night-shift handoff while the shift is OFF; dispatches normal work', async () => {
    await store.createProject({ name: 'p1' });
    await store.createGezel({ name: 'Bea' });
    await writeStepTask(1, { nightShift: true });
    await writeStepTask(2, {});

    const dispatcher = new FakeDispatcher(new Map([['bea', 'copilot']]));
    dispatcher.setProvider('copilot', new ProviderQueue({ concurrency: 10 }));

    const runner = new TaskRunner({ store, dispatcher, isNightShiftActive: () => false });
    runner.enqueueHandoff({ taskRef: 'p1/1', stepId: 'plan', gezelId: 'bea', projectId: 'p1' });
    runner.enqueueHandoff({ taskRef: 'p1/2', stepId: 'plan', gezelId: 'bea', projectId: 'p1' });
    await runner.tick();

    expect(dispatcher.dispatches.map((d) => d.taskRef)).toEqual(['p1/2']);
    expect(runner.snapshot().pendingCount).toBe(1); // the night task is held
  });

  it('holds night-shift handoffs while the index catch-up sweep runs, then releases', async () => {
    await store.createProject({ name: 'p1' });
    await store.createGezel({ name: 'Bea' });
    await writeStepTask(1, { nightShift: true });
    await writeStepTask(2, {});

    const dispatcher = new FakeDispatcher(new Map([['bea', 'copilot']]));
    dispatcher.setProvider('copilot', new ProviderQueue({ concurrency: 10 }));

    let catchUp = true;
    const runner = new TaskRunner({
      store,
      dispatcher,
      isNightShiftActive: () => true,
      isIndexCatchUpActive: () => catchUp,
    });
    runner.enqueueHandoff({ taskRef: 'p1/1', stepId: 'plan', gezelId: 'bea', projectId: 'p1' });
    runner.enqueueHandoff({ taskRef: 'p1/2', stepId: 'plan', gezelId: 'bea', projectId: 'p1' });
    await runner.tick();

    // Interactive work flows; the night task waits for a current index.
    expect(dispatcher.dispatches.map((d) => d.taskRef)).toEqual(['p1/2']);
    expect(runner.snapshot().pendingCount).toBe(1);

    catchUp = false;
    await runner.tick();
    expect(dispatcher.dispatches.map((d) => d.taskRef)).toEqual(['p1/2', 'p1/1']);
    expect(runner.snapshot().pendingCount).toBe(0);
  });

  it('prioritizes interactive work over a queued night-shift handoff for a scarce slot', async () => {
    await store.createProject({ name: 'p1' });
    await store.createGezel({ name: 'Bea' });
    await writeStepTask(1, { nightShift: true });
    await writeStepTask(2, {});

    const dispatcher = new FakeDispatcher(new Map([['bea', 'copilot']]));
    dispatcher.setProvider('copilot', new ProviderQueue({ concurrency: 1 }));

    const runner = new TaskRunner({ store, dispatcher, isNightShiftActive: () => true });
    // Night task enqueued FIRST — but the normal one must win the only slot.
    runner.enqueueHandoff({ taskRef: 'p1/1', stepId: 'plan', gezelId: 'bea', projectId: 'p1' });
    runner.enqueueHandoff({ taskRef: 'p1/2', stepId: 'plan', gezelId: 'bea', projectId: 'p1' });
    await runner.tick();

    expect(dispatcher.dispatches.map((d) => d.taskRef)).toEqual(['p1/2']);
    expect(runner.snapshot().pendingCount).toBe(1);
  });

  it('dispatches a night-shift handoff on the background lane when ON', async () => {
    await store.createProject({ name: 'p1' });
    await store.createGezel({ name: 'Bea' });
    await writeStepTask(1, { nightShift: true });

    const dispatcher = new FakeDispatcher(new Map([['bea', 'copilot']]));
    dispatcher.setProvider('copilot', new ProviderQueue({ concurrency: 10 }));

    const runner = new TaskRunner({ store, dispatcher, isNightShiftActive: () => true });
    runner.enqueueHandoff({ taskRef: 'p1/1', stepId: 'plan', gezelId: 'bea', projectId: 'p1' });
    await runner.tick();

    expect(dispatcher.dispatches).toHaveLength(1);
    expect(dispatcher.dispatches[0]?.lane).toBe('background');
    expect(dispatcher.dispatches[0]?.nightShift).toBe(true);
  });

  it('files held night work under `scheduled`, not the pending backlog', async () => {
    await store.createProject({ name: 'p1' });
    await store.createGezel({ name: 'Bea' });
    await writeStepTask(1, { nightShift: true });
    await writeStepTask(2, {});

    const dispatcher = new FakeDispatcher(new Map([['bea', 'copilot']]));
    // One slot, already taken — so the normal handoff is held too, and the
    // two buckets have to stay distinguishable while both are stuck.
    const queue = new ProviderQueue({ concurrency: 1 });
    await queue.acquire({ lane: 'interactive' });
    dispatcher.setProvider('copilot', queue);

    const runner = new TaskRunner({ store, dispatcher, isNightShiftActive: () => false });
    runner.enqueueHandoff({ taskRef: 'p1/1', stepId: 'plan', gezelId: 'bea', projectId: 'p1' });
    runner.enqueueHandoff({ taskRef: 'p1/2', stepId: 'plan', gezelId: 'bea', projectId: 'p1' });
    await runner.tick();

    const snap = runner.snapshot();
    expect(snap.pendingCount).toBe(2);
    expect(snap.scheduled).toEqual({ count: 1, byGezel: { bea: 1 } });
    expect(snap.dispatchable).toEqual({ count: 1, byGezel: { bea: 1 } });
    expect(snap.holdReason).toBe('provider-busy');
  });

  it('classifies night work as scheduled the moment it is enqueued', async () => {
    // Without the enqueue-time seed, a night task activated during the day
    // counts as a backlog item until the first tick reads it back off disk
    // — long enough for the header to flash a task count at the user.
    const runner = new TaskRunner({
      store,
      dispatcher: new FakeDispatcher(new Map()),
      isNightShiftActive: () => false,
    });
    runner.enqueueHandoff({
      taskRef: 'p1/1',
      stepId: 'plan',
      gezelId: 'bea',
      projectId: 'p1',
      nightShift: true,
    });

    expect(runner.snapshot().scheduled).toEqual({ count: 1, byGezel: { bea: 1 } });
    expect(runner.snapshot().dispatchable.count).toBe(0);
  });

  it('reports engagement-off as the hold reason', async () => {
    await store.createProject({ name: 'p1' });
    await store.createGezel({ name: 'Bea' });
    await writeStepTask(1, {});
    await store.writeConfig({ aiEngagementMode: 'off' });

    const dispatcher = new FakeDispatcher(new Map([['bea', 'copilot']]));
    dispatcher.setProvider('copilot', new ProviderQueue({ concurrency: 10 }));

    const runner = new TaskRunner({ store, dispatcher });
    runner.enqueueHandoff({ taskRef: 'p1/1', stepId: 'plan', gezelId: 'bea', projectId: 'p1' });
    await runner.tick();

    expect(runner.snapshot().holdReason).toBe('engagement-off');
  });

  it('holds every handoff under reactive engagement', async () => {
    // "Reactive only" promises the AI answers the user and does nothing
    // else. A handoff dispatch IS an unprompted turn, so the queue holds
    // rather than chaining a craftbook through the setting.
    await store.createProject({ name: 'p1' });
    await store.createGezel({ name: 'Bea' });
    await writeStepTask(1, {});
    await store.writeConfig({ aiEngagementMode: 'reactive' });

    const dispatcher = new FakeDispatcher(new Map([['bea', 'copilot']]));
    dispatcher.setProvider('copilot', new ProviderQueue({ concurrency: 10 }));

    const runner = new TaskRunner({ store, dispatcher });
    runner.enqueueHandoff({ taskRef: 'p1/1', stepId: 'plan', gezelId: 'bea', projectId: 'p1' });
    await runner.tick();

    expect(dispatcher.dispatches).toHaveLength(0);
    expect(runner.snapshot().pendingCount).toBe(1);
    expect(runner.snapshot().holdReason).toBe('engagement-paused');
  });

  it('holds a user-launched entry handoff under reactive too', async () => {
    // Letting `kind: 'entry'` through would run step 1 of a launched
    // craftbook and then stall at step 2 — that reads as broken, not
    // paused. The whole chain waits for the mode to come back up.
    await store.createProject({ name: 'p1' });
    await store.createGezel({ name: 'Bea' });
    await writeStepTask(1, {});
    await store.writeConfig({ aiEngagementMode: 'reactive' });

    const dispatcher = new FakeDispatcher(new Map([['bea', 'copilot']]));
    dispatcher.setProvider('copilot', new ProviderQueue({ concurrency: 10 }));

    const runner = new TaskRunner({ store, dispatcher });
    runner.enqueueHandoff({
      taskRef: 'p1/1',
      stepId: 'plan',
      gezelId: 'bea',
      projectId: 'p1',
      kind: 'entry',
    });
    await runner.tick();

    expect(dispatcher.dispatches).toHaveLength(0);
    expect(runner.snapshot().pendingCount).toBe(1);
  });

  it('dispatches under scheduled engagement', async () => {
    // "Tasks + Reactive" still runs the work the user set up; only
    // the proactive nudges are off.
    await store.createProject({ name: 'p1' });
    await store.createGezel({ name: 'Bea' });
    await writeStepTask(1, {});
    await store.writeConfig({ aiEngagementMode: 'scheduled' });

    const dispatcher = new FakeDispatcher(new Map([['bea', 'copilot']]));
    dispatcher.setProvider('copilot', new ProviderQueue({ concurrency: 10 }));

    const runner = new TaskRunner({ store, dispatcher });
    runner.enqueueHandoff({ taskRef: 'p1/1', stepId: 'plan', gezelId: 'bea', projectId: 'p1' });
    await runner.tick();

    expect(dispatcher.dispatches).toHaveLength(1);
    expect(runner.snapshot().holdReason).toBeUndefined();
  });

  it('resumes held handoffs when engagement is raised again', async () => {
    await store.createProject({ name: 'p1' });
    await store.createGezel({ name: 'Bea' });
    await writeStepTask(1, {});
    await store.writeConfig({ aiEngagementMode: 'reactive' });

    const dispatcher = new FakeDispatcher(new Map([['bea', 'copilot']]));
    dispatcher.setProvider('copilot', new ProviderQueue({ concurrency: 10 }));

    const runner = new TaskRunner({ store, dispatcher });
    runner.enqueueHandoff({ taskRef: 'p1/1', stepId: 'plan', gezelId: 'bea', projectId: 'p1' });
    await runner.tick();
    expect(dispatcher.dispatches).toHaveLength(0);

    await store.writeConfig({ aiEngagementMode: 'proactive' });
    await runner.tick();

    expect(dispatcher.dispatches).toHaveLength(1);
    expect(runner.snapshot().pendingCount).toBe(0);
  });

  it('holds a night-shift task that already ran today (not pending)', async () => {
    await store.createProject({ name: 'p1' });
    await store.createGezel({ name: 'Bea' });
    await writeStepTask(1, { nightShift: true });

    const dispatcher = new FakeDispatcher(new Map([['bea', 'copilot']]));
    dispatcher.setProvider('copilot', new ProviderQueue({ concurrency: 10 }));

    const runner = new TaskRunner({
      store,
      dispatcher,
      isNightShiftActive: () => true,
      isNightShiftPending: () => false, // already ran today
    });
    runner.enqueueHandoff({ taskRef: 'p1/1', stepId: 'plan', gezelId: 'bea', projectId: 'p1' });
    await runner.tick();

    expect(dispatcher.dispatches).toHaveLength(0);
    expect(runner.snapshot().pendingCount).toBe(1);
  });
});

describe('TaskRunner — night quota reserve gating', () => {
  const hold: QuotaReserveHold = {
    provider: 'copilot',
    bucket: 'premium_interactions',
    remainingPercent: 10,
    floorPercent: 20,
    rule: 'overall',
  };

  async function writeStepTask(
    num: number,
    opts: { nightShift?: boolean; gezelId?: string },
  ): Promise<void> {
    const now = new Date().toISOString();
    const gezelId = opts.gezelId ?? 'bea';
    await store.writeTask({
      projectId: 'p1',
      num,
      ref: `p1/${num}`,
      title: `t${num}`,
      status: 'active',
      assignee: { kind: 'gezel', gezelId },
      craftbook: fixtureCraftbook([
        { id: 'plan', name: 'plan', assignee: { kind: 'gezel', gezelId }, createdAt: now },
      ]),
      activeStepId: 'plan',
      ...(opts.nightShift ? { nightShift: { enabled: true } } : {}),
      createdAt: now,
      updatedAt: now,
      createdBy: { kind: 'user' },
    });
  }

  it('holds a night handoff under quota, files it as scheduled, then releases', async () => {
    await store.createProject({ name: 'p1' });
    await store.createGezel({ name: 'Bea' });
    await writeStepTask(1, { nightShift: true });

    const dispatcher = new FakeDispatcher(new Map([['bea', 'copilot']]));
    dispatcher.setProvider('copilot', new ProviderQueue({ concurrency: 10 }));

    let verdict: QuotaReserveHold | null = hold;
    const runner = new TaskRunner({
      store,
      dispatcher,
      isNightShiftActive: () => true,
      nightQuotaHold: async () => verdict,
    });
    runner.enqueueHandoff({ taskRef: 'p1/1', stepId: 'plan', gezelId: 'bea', projectId: 'p1' });
    await runner.tick();

    expect(dispatcher.dispatches).toHaveLength(0);
    const snap = runner.snapshot();
    expect(snap.scheduled).toEqual({ count: 1, byGezel: { bea: 1 } });
    expect(snap.dispatchable.count).toBe(0);
    expect(snap.holdReason).toBeUndefined();

    // Quota freed (e.g. a five_hour window reset) — the next tick dispatches.
    verdict = null;
    await runner.tick();
    expect(dispatcher.dispatches.map((d) => d.taskRef)).toEqual(['p1/1']);
    expect(runner.snapshot().pendingCount).toBe(0);
  });

  it('holds only the gated provider: local night work keeps flowing', async () => {
    await store.createProject({ name: 'p1' });
    await store.createGezel({ name: 'Bea' });
    await store.createGezel({ name: 'Cas' });
    await writeStepTask(1, { nightShift: true, gezelId: 'bea' });
    await writeStepTask(2, { nightShift: true, gezelId: 'cas' });

    const dispatcher = new FakeDispatcher(
      new Map([
        ['bea', 'copilot'],
        ['cas', 'llama-cpp'],
      ]),
    );
    dispatcher.setProvider('copilot', new ProviderQueue({ concurrency: 10 }));
    dispatcher.setProvider('llama-cpp', new ProviderQueue({ concurrency: 10 }));

    const runner = new TaskRunner({
      store,
      dispatcher,
      isNightShiftActive: () => true,
      nightQuotaHold: async (provider) => (provider === 'copilot' ? hold : null),
    });
    runner.enqueueHandoff({ taskRef: 'p1/1', stepId: 'plan', gezelId: 'bea', projectId: 'p1' });
    runner.enqueueHandoff({ taskRef: 'p1/2', stepId: 'plan', gezelId: 'cas', projectId: 'p1' });
    await runner.tick();

    expect(dispatcher.dispatches.map((d) => d.taskRef)).toEqual(['p1/2']);
    expect(runner.snapshot().scheduled).toEqual({ count: 1, byGezel: { bea: 1 } });
  });

  it('does not quota-gate daytime (non-night) work on the same provider', async () => {
    await store.createProject({ name: 'p1' });
    await store.createGezel({ name: 'Bea' });
    await writeStepTask(1, {});

    const dispatcher = new FakeDispatcher(new Map([['bea', 'copilot']]));
    dispatcher.setProvider('copilot', new ProviderQueue({ concurrency: 10 }));

    const gate = vi.fn(async () => hold);
    const runner = new TaskRunner({
      store,
      dispatcher,
      isNightShiftActive: () => true,
      nightQuotaHold: gate,
    });
    runner.enqueueHandoff({ taskRef: 'p1/1', stepId: 'plan', gezelId: 'bea', projectId: 'p1' });
    await runner.tick();

    expect(dispatcher.dispatches.map((d) => d.taskRef)).toEqual(['p1/1']);
    expect(gate).not.toHaveBeenCalled();
  });

  it('dispatches when the gate rejects (optimistic on gate failure)', async () => {
    await store.createProject({ name: 'p1' });
    await store.createGezel({ name: 'Bea' });
    await writeStepTask(1, { nightShift: true });

    const dispatcher = new FakeDispatcher(new Map([['bea', 'copilot']]));
    dispatcher.setProvider('copilot', new ProviderQueue({ concurrency: 10 }));

    const runner = new TaskRunner({
      store,
      dispatcher,
      isNightShiftActive: () => true,
      nightQuotaHold: async () => {
        throw new Error('gate exploded');
      },
    });
    runner.enqueueHandoff({ taskRef: 'p1/1', stepId: 'plan', gezelId: 'bea', projectId: 'p1' });
    await runner.tick();

    expect(dispatcher.dispatches.map((d) => d.taskRef)).toEqual(['p1/1']);
  });
});

describe('TaskRunner — capability-floor derivation at dispatch', () => {
  async function writeFloorTask(step: Partial<TaskCraftbookStep> & { id: string }): Promise<void> {
    const now = new Date().toISOString();
    await store.writeTask({
      projectId: 'p1',
      num: 1,
      ref: 'p1/1',
      title: 't',
      status: 'active',
      assignee: { kind: 'gezel', gezelId: 'bea' },
      craftbook: fixtureCraftbook([
        {
          name: step.id,
          assignee: { kind: 'gezel', gezelId: 'bea' },
          createdAt: now,
          ...step,
        } as TaskCraftbookStep,
      ]),
      activeStepId: step.id,
      createdAt: now,
      updatedAt: now,
      createdBy: { kind: 'user' },
    });
  }

  async function dispatchOnce(): Promise<FakeDispatcher['dispatches'][number]> {
    const dispatcher = new FakeDispatcher(new Map([['bea', 'copilot']]));
    dispatcher.setProvider('copilot', new ProviderQueue({ concurrency: 10 }));
    const runner = new TaskRunner({ store, dispatcher });
    runner.enqueueHandoff({ taskRef: 'p1/1', stepId: 'work', gezelId: 'bea', projectId: 'p1' });
    await runner.tick();
    expect(dispatcher.dispatches).toHaveLength(1);
    return dispatcher.dispatches[0]!;
  }

  beforeEach(async () => {
    await store.createProject({ name: 'p1' });
    await store.createGezel({ name: 'Bea' });
  });

  it('an explicit step capabilityFloor passes through with the book join key', async () => {
    await writeFloorTask({ id: 'work', capabilityFloor: 'medium' });
    const dispatch = await dispatchOnce();
    expect(dispatch.capabilityFloor).toBe('medium');
    expect(dispatch.bookCatalogId).toBe('cb-test');
  });

  it('a suggestedRole derives the registry floor (developer → small)', async () => {
    await writeFloorTask({ id: 'work', suggestedRole: 'developer' });
    const dispatch = await dispatchOnce();
    expect(dispatch.capabilityFloor).toBe('small');
  });

  it('an explicit floor overrides the role floor', async () => {
    await writeFloorTask({ id: 'work', suggestedRole: 'developer', capabilityFloor: 'large' });
    const dispatch = await dispatchOnce();
    expect(dispatch.capabilityFloor).toBe('large');
  });

  it('neither floor nor role → no floor fields on the dispatch', async () => {
    await writeFloorTask({ id: 'work' });
    const dispatch = await dispatchOnce();
    expect(dispatch.capabilityFloor).toBeUndefined();
    expect(dispatch.bookCatalogId).toBeUndefined();
  });
});

describe('TaskRunner — entry-kind passthrough', () => {
  it("an enqueued kind:'entry' handoff reaches startHandoffSession as kind:'entry'", async () => {
    await store.createProject({ name: 'p1' });
    await store.createGezel({ name: 'Bea' });
    const now = new Date().toISOString();
    await store.writeTask({
      projectId: 'p1',
      num: 1,
      ref: 'p1/1',
      title: 't',
      status: 'active',
      assignee: { kind: 'gezel', gezelId: 'bea' },
      craftbook: fixtureCraftbook([
        { id: 'build', name: 'build', assignee: { kind: 'gezel', gezelId: 'bea' }, createdAt: now },
      ]),
      activeStepId: 'build',
      createdAt: now,
      updatedAt: now,
      createdBy: { kind: 'user' },
    });

    const dispatcher = new FakeDispatcher(new Map([['bea', 'copilot']]));
    dispatcher.setProvider('copilot', new ProviderQueue({ concurrency: 10 }));
    const runner = new TaskRunner({ store, dispatcher });
    runner.enqueueHandoff({
      taskRef: 'p1/1',
      stepId: 'build',
      gezelId: 'bea',
      projectId: 'p1',
      kind: 'entry',
    });
    await runner.tick();

    expect(dispatcher.dispatches).toHaveLength(1);
    expect(dispatcher.dispatches[0]?.kind).toBe('entry');
  });
});

describe('TaskRunner — waitingStates', () => {
  async function seedTask(num: number, gezelId: string): Promise<void> {
    const now = new Date().toISOString();
    await store.writeTask({
      projectId: 'p1',
      num,
      ref: `p1/${num}`,
      title: `t${num}`,
      status: 'active',
      assignee: { kind: 'gezel', gezelId },
      craftbook: fixtureCraftbook([
        { id: 'plan', name: 'plan', assignee: { kind: 'gezel', gezelId }, createdAt: now },
      ]),
      activeStepId: 'plan',
      createdAt: now,
      updatedAt: now,
      createdBy: { kind: 'user' },
    });
  }

  it('reports nothing when the queue is empty', () => {
    const runner = new TaskRunner({
      store,
      dispatcher: new FakeDispatcher(new Map([['bea', 'copilot']])),
    });
    expect(runner.waitingStates()).toEqual([]);
  });

  it("names a queued handoff, who it's for, and when it was enqueued", () => {
    const runner = new TaskRunner({
      store,
      dispatcher: new FakeDispatcher(new Map([['bea', 'copilot']])),
      now: () => Date.parse('2026-08-21T05:30:00.000Z'),
    });
    runner.enqueueHandoff({ taskRef: 'p1/6', stepId: 'plan', gezelId: 'bea', projectId: 'p1' });

    expect(runner.waitingStates()).toEqual([
      {
        ref: 'p1/6',
        reason: 'queued',
        gezelId: 'bea',
        stepId: 'plan',
        since: '2026-08-21T05:30:00.000Z',
      },
    ]);
  });

  it('files a night-shift handoff as scheduled rather than as backlog', () => {
    const runner = new TaskRunner({
      store,
      dispatcher: new FakeDispatcher(new Map([['bea', 'copilot']])),
    });
    runner.enqueueHandoff({
      taskRef: 'p1/6',
      stepId: 'plan',
      gezelId: 'bea',
      projectId: 'p1',
      nightShift: true,
    });
    expect(runner.waitingStates()[0]?.reason).toBe('night-shift');
  });

  it('reports a dispatched handoff as starting, superseding its queue entry', async () => {
    await store.createProject({ name: 'p1' });
    await store.createGezel({ name: 'Bea' });
    await seedTask(6, 'bea');

    const dispatcher = new FakeDispatcher(new Map([['bea', 'copilot']]));
    dispatcher.setProvider('copilot', new ProviderQueue({ concurrency: 10 }));
    const runner = new TaskRunner({ store, dispatcher });
    runner.enqueueHandoff({ taskRef: 'p1/6', stepId: 'plan', gezelId: 'bea', projectId: 'p1' });
    await runner.tick();

    const states = runner.waitingStates();
    expect(states).toHaveLength(1);
    expect(states[0]?.reason).toBe('dispatching');
    expect(states[0]?.ref).toBe('p1/6');
  });

  it('drops a task once its dispatch settles', async () => {
    await store.createProject({ name: 'p1' });
    await store.createGezel({ name: 'Bea' });
    await seedTask(6, 'bea');

    const dispatcher = new FakeDispatcher(new Map([['bea', 'copilot']]));
    dispatcher.setProvider('copilot', new ProviderQueue({ concurrency: 10 }));
    const runner = new TaskRunner({ store, dispatcher });
    runner.enqueueHandoff({ taskRef: 'p1/6', stepId: 'plan', gezelId: 'bea', projectId: 'p1' });
    await runner.tick();
    // The session finishing is what ends the "starting" window: with no
    // active dispatch left the card must disappear, not linger claiming
    // work is about to begin.
    dispatcher.activeSessionIds.clear();
    await runner.tick();

    expect(runner.waitingStates()).toEqual([]);
  });
});
