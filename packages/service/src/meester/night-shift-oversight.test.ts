import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeStepGate } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import { HistoryManager } from '../history/manager.js';
import { TaskManager } from '../tasks/manager.js';
import { ensureNightShiftOversightTask } from './night-shift-oversight.js';

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
});
