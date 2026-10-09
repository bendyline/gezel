import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeStepGate } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import { HistoryManager } from '../history/manager.js';
import { TaskManager } from '../tasks/manager.js';
import {
  ensureNightShiftOversightTask,
  findNightShiftOversightTask,
  isNightShiftOversightTask,
} from './night-shift-oversight.js';

const OVERSIGHT_TITLE = 'Night-shift oversight: project review';

let home: string;
let store: Store;
let tasks: TaskManager;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-night-shift-'));
  const history = new HistoryManager(home);
  store = new Store({ home, history });
  await store.ensureLayout();
  await store.ensureDefaultProject();
  tasks = new TaskManager(store, history);
  const meester = await store.createGezel({ name: 'Wren', role: 'Meester' });
  await store.writeConfig({ meesterGezelId: meester.id });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const oversightStep = async () => {
  const list = await store.listProjectTasks('default');
  const installed = list.find((t) => t.title === OVERSIGHT_TITLE);
  expect(installed).toBeDefined();
  const task = await store.readTask('default', installed!.num);
  return { task: task!, step: task!.craftbook.steps.find((s) => s.id === 'oversight')! };
};

/**
 * `advanceWhen` drives the auto-advance watcher only; `completeStep`
 * rejects a step solely on its `gate`. Without one, a run that never wrote
 * the report called `advance_task_step` and sailed through — observed at
 * attempt 7, after which the task re-armed for the next night as if the
 * review had happened.
 */
describe('night-shift oversight task', () => {
  it('installs the step with a completion gate on the report artifact', async () => {
    await ensureNightShiftOversightTask(store, tasks);
    const { step } = await oversightStep();

    expect(step.gate).toBeDefined();
    const gate = normalizeStepGate(step.gate!);
    expect(gate.at).toBe('completion');
    expect(gate.checks).toEqual([
      { kind: 'minBytes', file: 'night-shift-report.md', bytes: 200, artifact: true },
    ]);
    // The watcher path keeps its own freshness guard.
    expect(step.advanceWhen).toMatchObject({
      file: 'night-shift-report.md',
      artifact: true,
      requireChange: true,
    });
  });

  it('stamps the gate onto an install that predates it', async () => {
    await ensureNightShiftOversightTask(store, tasks);
    const { task } = await oversightStep();

    // Reproduce the shipped-before-the-fix shape: deliverable declared,
    // nothing enforcing it on an explicit advance.
    await store.writeTask({
      ...task,
      craftbook: {
        ...task.craftbook,
        steps: task.craftbook.steps.map((s) => {
          if (s.id !== 'oversight') return s;
          const { gate: _dropped, ...withoutGate } = s;
          return withoutGate;
        }),
      },
    });
    expect((await oversightStep()).step.gate).toBeUndefined();

    await ensureNightShiftOversightTask(store, tasks);

    const restamped = (await oversightStep()).step.gate;
    expect(restamped).toBeDefined();
    expect(normalizeStepGate(restamped!).checks).toEqual([
      { kind: 'minBytes', file: 'night-shift-report.md', bytes: 200, artifact: true },
    ]);
  });

  it('is idempotent once the gate is current', async () => {
    await ensureNightShiftOversightTask(store, tasks);
    const first = await oversightStep();
    await ensureNightShiftOversightTask(store, tasks);
    const second = await oversightStep();

    expect(second.task.updatedAt).toBe(first.task.updatedAt);
    expect(await store.listProjectTasks('default')).toHaveLength(1);
  });

  /**
   * Earlier builds charged the waiting oversight step on every launch and
   * paused it on the fourth, with a "Needs your input" card about a task that
   * had never run. Found on a dev home paused for a month.
   */
  describe('restart-budget pause from earlier builds', () => {
    const pauseLikeAnEarlierBuild = async (restartResumeCount: number) => {
      await ensureNightShiftOversightTask(store, tasks);
      const { task } = await oversightStep();
      await store.writeTask({
        ...task,
        status: 'paused',
        craftbook: {
          ...task.craftbook,
          steps: task.craftbook.steps.map((s) =>
            s.id === 'oversight' ? { ...s, restartResumeCount } : s,
          ),
        },
      });
      await store.writeQuestion({
        id: 'q-paused',
        projectId: 'default',
        gezelId: task.assignee.kind === 'gezel' ? task.assignee.gezelId : '',
        sessionId: '',
        prompt: `Task ${task.ref} paused for help at step \`oversight\``,
        choices: ['Dismiss'],
        allowWriteIn: false,
        multiSelect: false,
        taskRef: task.ref,
        intent: {
          kind: 'task-paused',
          taskRef: task.ref,
          stepId: 'oversight',
          reason: 'step_stalled',
        },
        createdAt: new Date().toISOString(),
      });
      return task;
    };

    it('resumes the task and clears its card', async () => {
      await pauseLikeAnEarlierBuild(4);
      await ensureNightShiftOversightTask(store, tasks);

      const { task, step } = await oversightStep();
      expect(task.status).toBe('active');
      expect(step.restartResumeCount).toBeUndefined();
      const card = await store.getQuestion('default', 'q-paused');
      expect(card?.answer?.silentSkip).toBe(true);
    });

    it('resumes a pause of any kind with a fresh budget, so nobody presses Resume', async () => {
      await pauseLikeAnEarlierBuild(2);
      const paused = await oversightStep();
      await store.writeTask({
        ...paused.task,
        craftbook: {
          ...paused.task.craftbook,
          steps: paused.task.craftbook.steps.map((s) =>
            s.id === 'oversight' ? { ...s, redriveCount: 3, gateAttempts: 3 } : s,
          ),
        },
      });
      await ensureNightShiftOversightTask(store, tasks);

      const { task, step } = await oversightStep();
      expect(task.status).toBe('active');
      expect(step.redriveCount ?? 0).toBe(0);
      expect(step.gateAttempts).toBeUndefined();
      expect((await store.getQuestion('default', 'q-paused'))?.answer?.silentSkip).toBe(true);
    });
  });

  // A re-driven run asked the person how to settle a mismatch between two
  // runtime guards (2026-10-08). Nobody is awake to answer the review.
  describe('never asks the person anything', () => {
    it('tells the run, in its step, that nobody can answer', async () => {
      await ensureNightShiftOversightTask(store, tasks);
      const { step } = await oversightStep();
      expect(step.prompt).toContain('never ask the user anything');
      // `ask_user_question` is a workflow safety tool no step policy may
      // remove; the question route declines it instead.
      expect(step.toolPolicy).toBeUndefined();
    });

    it("withdraws what a run already asked, and leaves other work's questions", async () => {
      await ensureNightShiftOversightTask(store, tasks);
      const { task } = await oversightStep();
      const ask = (id: string, taskRef?: string) =>
        store.writeQuestion({
          id,
          projectId: 'default',
          gezelId: 'wren',
          sessionId: 'session-1',
          prompt: 'The recurring re-arm is generating false re-nudges. How should I handle it?',
          choices: ['The report is done', 'Pause the task'],
          allowWriteIn: true,
          multiSelect: false,
          ...(taskRef ? { taskRef } : {}),
          createdAt: new Date().toISOString(),
        });
      await ask('q-review', task.ref);
      await ask('q-other', 'default/9');
      await ask('q-chat');

      await ensureNightShiftOversightTask(store, tasks);

      expect((await store.getQuestion('default', 'q-review'))?.answer?.silentSkip).toBe(true);
      expect((await store.getQuestion('default', 'q-other'))?.answer).toBeUndefined();
      expect((await store.getQuestion('default', 'q-chat'))?.answer).toBeUndefined();
    });

    it("is recognized as the runtime's own work, which files no paused-for-help card", async () => {
      await ensureNightShiftOversightTask(store, tasks);
      const { task } = await oversightStep();
      expect(isNightShiftOversightTask(task)).toBe(true);
      expect(isNightShiftOversightTask({ ...task, projectId: 'pics' })).toBe(false);
      expect(isNightShiftOversightTask({ ...task, title: 'Weekly digest' })).toBe(false);
    });
  });

  it('finds the installed task, paused or not, for the morning card', async () => {
    expect(await findNightShiftOversightTask(store)).toBeNull();
    await ensureNightShiftOversightTask(store, tasks);
    const found = await findNightShiftOversightTask(store);
    expect(found?.title).toBe(OVERSIGHT_TITLE);

    await tasks.setStatus('default', found!.num, 'paused');
    expect((await findNightShiftOversightTask(store))?.status).toBe('paused');
    // Ensuring again (each window open) resumes it for that night.
    await ensureNightShiftOversightTask(store, tasks);
    expect((await findNightShiftOversightTask(store))?.status).toBe('active');
  });
});
