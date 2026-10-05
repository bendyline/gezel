import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectTaskFile } from '@bendyline/gezel/paths';
import { errorToResponse } from '@bendyline/gezel/runtime';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Store } from '../fs/store.js';
import { TaskWriteConflictError } from '../fs/task-files-store.js';
import type { ScriptRunner } from '../scripts/runner.js';
import { TaskManager } from './manager.js';

let home: string;
let store: Store;
let tasks: TaskManager;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-task-concurrency-'));
  store = new Store({ home });
  await store.ensureLayout();
  await store.createProject({ name: 'Fixture' });
  tasks = new TaskManager(store);
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

it('keeps a completed pause when an earlier retitle finishes late', async () => {
  const task = await tasks.create('fixture', {
    title: 'Before',
    assignee: { kind: 'user' },
    steps: [{ name: 'Work' }],
  });
  const arrived = deferred();
  const release = deferred();
  const original = store.writeTask.bind(store);
  let blocked = false;
  const spy = vi.spyOn(store, 'writeTask').mockImplementation(async (next) => {
    if (!blocked && next.title === 'Retitled' && next.status === 'active') {
      blocked = true;
      arrived.resolve();
      await release.promise;
    }
    return original(next);
  });
  try {
    const retitle = tasks.update('fixture', task.num, { title: 'Retitled' });
    await arrived.promise;
    await tasks.setStatus('fixture', task.num, 'paused');
    release.resolve();
    expect(await retitle).toMatchObject({ title: 'Retitled', status: 'paused' });
    expect(await store.readTask('fixture', task.num)).toMatchObject({
      title: 'Retitled',
      status: 'paused',
    });
  } finally {
    release.resolve();
    spy.mockRestore();
  }
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it('rejects stale transitions across Store instances before changing metadata or prose', async () => {
  const task = await tasks.create('fixture', {
    title: 'Before',
    assignee: { kind: 'user' },
    steps: [{ name: 'Work' }],
  });
  const otherStore = new Store({ home });
  const stale = (await otherStore.readTask('fixture', task.num))!;
  await tasks.update('fixture', task.num, { description: 'new user description' });
  await tasks.setStatus('fixture', task.num, 'canceled');
  const conflict = await otherStore
    .writeTask({ ...stale, status: 'complete' })
    .catch((error: unknown) => error);
  expect(conflict).toBeInstanceOf(TaskWriteConflictError);
  expect(errorToResponse(conflict, { exposeUnknown: false })).toMatchObject({
    status: 409,
    body: { error: expect.stringContaining('changed while it was being edited') },
  });
  expect(await store.readTask('fixture', task.num)).toMatchObject({
    status: 'canceled',
    description: 'new user description',
  });
});

it.each(['paused', 'canceled'] as const)(
  'rejects late step completion after the task is %s',
  async (status) => {
    const task = await tasks.create('fixture', {
      title: 'Before',
      assignee: { kind: 'user' },
      steps: [{ name: 'Work' }, { name: 'Review' }],
    });
    const arrived = deferred();
    const release = deferred();
    const activated = vi.fn();
    tasks.setStepActivatedHook(activated);
    const original = store.writeTask.bind(store);
    let blocked = false;
    const spy = vi.spyOn(store, 'writeTask').mockImplementation(async (next) => {
      if (!blocked) {
        blocked = true;
        arrived.resolve();
        await release.promise;
      }
      return original(next);
    });
    // Attach rejection handling before releasing the barrier to avoid an unhandled rejection.
    const completion = tasks.completeStep('fixture', task.num, task.activeStepId!).then(
      () => null,
      (error: unknown) => error,
    );
    try {
      await arrived.promise;
      const other = new TaskManager(new Store({ home }));
      await other.update('fixture', task.num, {
        title: 'User edit',
        description: 'Keep this prose',
      });
      await other.setStatus('fixture', task.num, status);
      release.resolve();
      expect(await completion).toBeInstanceOf(TaskWriteConflictError);
      expect(await store.readTask('fixture', task.num)).toMatchObject({
        title: 'User edit',
        description: 'Keep this prose',
        status,
        activeStepId: task.activeStepId,
      });
      expect(activated).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await completion;
      spy.mockRestore();
    }
  },
);

it('starts legacy tasks at revision zero and protects their first overlapping writes', async () => {
  const task = await tasks.create('fixture', {
    title: 'Legacy',
    assignee: { kind: 'user' },
    steps: [{ name: 'Work' }],
  });
  const file = projectTaskFile(home, 'fixture', task.num);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  delete saved.revision;
  await writeFile(file, JSON.stringify(saved));
  const first = (await store.readTask('fixture', task.num))!;
  const second = (await store.readTask('fixture', task.num))!;
  await store.writeTask({ ...first, status: 'paused' });
  await expect(store.writeTask({ ...second, title: 'stale' })).rejects.toBeInstanceOf(
    TaskWriteConflictError,
  );
  expect(await store.readTask('fixture', task.num)).toMatchObject({
    title: 'Legacy',
    status: 'paused',
    revision: 1,
  });
});

function scriptRun(scriptName: string, output: unknown) {
  return {
    id: `run-${scriptName}`,
    projectId: 'fixture',
    scriptName,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    status: 'ok' as const,
    trigger: { kind: 'manual' as const, userInitiated: true as const },
    inputs: {},
    output,
    calls: [],
    logs: '',
  };
}

it('advances a step whose gate and onExit scripts updated their own task', async () => {
  let num = 0;
  const run = vi.fn(async ({ scriptName }: { scriptName: string }) => {
    if (scriptName === 'verify') {
      await tasks.update('fixture', num, { title: 'Set by the gate' });
      return scriptRun(scriptName, { decision: 'approve' });
    }
    await tasks.update('fixture', num, { description: 'Written by the onExit script' });
    return scriptRun(scriptName, { ok: true });
  });
  tasks.setScriptRunner({ run } as unknown as ScriptRunner);
  const activated = vi.fn(async () => {});
  tasks.setStepActivatedHook(activated);
  const task = await tasks.create('fixture', {
    title: 'Before',
    assignee: { kind: 'user' },
    steps: [
      {
        id: 'build',
        name: 'Build',
        assignee: { kind: 'user' },
        gate: { at: 'completion', scripts: [{ name: 'verify', scope: 'standard' }] } as never,
        onExit: { name: 'publish', scope: 'standard' },
      },
      { id: 'ship', name: 'Ship', assignee: { kind: 'user' } },
    ],
  });
  num = task.num;

  const outcome = await tasks.completeStepChecked('fixture', num, 'build', undefined, {
    cause: 'model',
  });

  expect(outcome.status).toBe('advanced');
  expect(run.mock.calls.map(([input]) => input.scriptName)).toEqual(['verify', 'publish']);
  const stored = (await store.readTask('fixture', num))!;
  expect(stored).toMatchObject({
    title: 'Set by the gate',
    description: 'Written by the onExit script',
    status: 'active',
    activeStepId: 'ship',
  });
  expect(stored.craftbook.steps.find((s) => s.id === 'build')?.completedAt).toBeDefined();
  expect(activated).toHaveBeenCalledWith(
    expect.objectContaining({ newStep: expect.objectContaining({ id: 'ship' }) }),
  );
});

it('records a gate rejection on top of the gate script update to its own task', async () => {
  let num = 0;
  tasks.setScriptRunner({
    run: async ({ scriptName }: { scriptName: string }) => {
      await tasks.update('fixture', num, { title: 'Touched by the gate' });
      return scriptRun(scriptName, { decision: 'reject', message: 'Not yet: add the summary.' });
    },
  } as unknown as ScriptRunner);
  const task = await tasks.create('fixture', {
    title: 'Before',
    assignee: { kind: 'user' },
    steps: [
      {
        id: 'build',
        name: 'Build',
        assignee: { kind: 'user' },
        gate: { at: 'completion', scripts: [{ name: 'verify', scope: 'standard' }] } as never,
      },
      { id: 'ship', name: 'Ship', assignee: { kind: 'user' } },
    ],
  });
  num = task.num;

  const outcome = await tasks.completeStepChecked('fixture', num, 'build', undefined, {
    cause: 'model',
  });

  expect(outcome.status).toBe('held');
  const stored = (await store.readTask('fixture', num))!;
  expect(stored).toMatchObject({ title: 'Touched by the gate', activeStepId: 'build' });
  expect(stored.craftbook.steps.find((s) => s.id === 'build')).toMatchObject({
    gateAttempts: 1,
    lastGateReject: { message: expect.stringContaining('add the summary') },
  });
});

it('keeps a concurrent user edit when a restart resume is counted', async () => {
  const task = await tasks.create('fixture', {
    title: 'Before',
    assignee: { kind: 'user' },
    steps: [{ name: 'Work' }, { name: 'Review' }],
  });
  const stepId = task.activeStepId!;
  const arrived = deferred();
  const release = deferred();
  const original = store.writeTask.bind(store);
  let blocked = false;
  const spy = vi.spyOn(store, 'writeTask').mockImplementation(async (next) => {
    const counted = next.craftbook.steps.some((s) => s.restartResumeCount !== undefined);
    if (!blocked && counted) {
      blocked = true;
      arrived.resolve();
      await release.promise;
    }
    return original(next);
  });
  try {
    const resume = tasks.noteRestartResume('fixture', task.num, stepId);
    await arrived.promise;
    await new TaskManager(new Store({ home })).update('fixture', task.num, {
      title: 'User edit',
    });
    release.resolve();
    expect(await resume).toEqual({ count: 1, exhausted: false });
    const stored = (await store.readTask('fixture', task.num))!;
    expect(stored.title).toBe('User edit');
    expect(stored.craftbook.steps.find((s) => s.id === stepId)?.restartResumeCount).toBe(1);
  } finally {
    release.resolve();
    spy.mockRestore();
  }
});

it('persists a resolved role even when the task moved after the transition committed', async () => {
  let num = 0;
  let edited = false;
  tasks.setRoleResolver(async (role) => {
    if (role !== 'Reviewer') return null;
    if (!edited) {
      edited = true;
      await new TaskManager(new Store({ home })).update('fixture', num, { title: 'User edit' });
    }
    return { gezelId: 'reviewer-gezel' };
  });
  const activated = vi.fn(async () => {});
  tasks.setStepActivatedHook(activated);
  const task = await tasks.create('fixture', {
    title: 'Before',
    assignee: { kind: 'user' },
    steps: [
      { id: 'build', name: 'Build', assignee: { kind: 'user' } },
      { id: 'review', name: 'Review', suggestedRole: 'Reviewer' },
    ],
  });
  num = task.num;

  const outcome = await tasks.completeStepChecked('fixture', num, 'build');

  expect(outcome.status).toBe('advanced');
  const stored = (await store.readTask('fixture', num))!;
  expect(stored.title).toBe('User edit');
  expect(stored.activeStepId).toBe('review');
  expect(stored.craftbook.steps.find((s) => s.id === 'review')?.suggestedGezelId).toBe(
    'reviewer-gezel',
  );
  expect(activated).toHaveBeenCalledWith(
    expect.objectContaining({
      newStep: expect.objectContaining({ id: 'review', suggestedGezelId: 'reviewer-gezel' }),
    }),
  );
});

it('still answers a user edit that keeps conflicting with 409 after its retries', async () => {
  const task = await tasks.create('fixture', {
    title: 'Before',
    assignee: { kind: 'user' },
    steps: [{ name: 'Work' }],
  });
  const spy = vi.spyOn(store, 'writeTask').mockImplementation(async (next) => {
    throw new TaskWriteConflictError(next.ref);
  });
  try {
    const conflict = await tasks
      .update('fixture', task.num, { title: 'Never lands' })
      .catch((error: unknown) => error);
    expect(conflict).toBeInstanceOf(TaskWriteConflictError);
    expect(errorToResponse(conflict, { exposeUnknown: false })).toMatchObject({ status: 409 });
    expect(spy).toHaveBeenCalledTimes(3);
  } finally {
    spy.mockRestore();
  }
  expect(await store.readTask('fixture', task.num)).toMatchObject({ title: 'Before' });
});

it('discards a gate rejection whose budget was reset while the gate ran', async () => {
  let num = 0;
  let calls = 0;
  tasks.setScriptRunner({
    run: async ({ scriptName }: { scriptName: string }) => {
      calls += 1;
      // The second evaluation races a Keurmeester verdict / Try again reset.
      if (calls === 2) {
        await tasks.resetStepRecoveryBudget('fixture', num, 'build', { clearGateAttempts: true });
      }
      return scriptRun(scriptName, { decision: 'reject', message: 'Still missing the summary.' });
    },
  } as unknown as ScriptRunner);
  const needsHelp = vi.fn(async () => {});
  tasks.setTaskNeedsHelpHook(needsHelp);
  const task = await tasks.create('fixture', {
    title: 'Gated',
    assignee: { kind: 'user' },
    steps: [
      {
        id: 'build',
        name: 'Build',
        assignee: { kind: 'user' },
        gate: {
          at: 'completion',
          maxAttempts: 2,
          scripts: [{ name: 'verify', scope: 'standard' }],
        } as never,
      },
      { id: 'ship', name: 'Ship', assignee: { kind: 'user' } },
    ],
  });
  num = task.num;
  const first = await tasks.completeStepChecked('fixture', num, 'build', undefined, {
    cause: 'model',
  });
  expect(first.status).toBe('held');

  const stale = await tasks
    .completeStepChecked('fixture', num, 'build', undefined, { cause: 'model' })
    .catch((error: unknown) => error);

  expect(stale).toBeInstanceOf(TaskWriteConflictError);
  const stored = (await store.readTask('fixture', num))!;
  expect(stored).toMatchObject({ status: 'active', activeStepId: 'build' });
  const build = stored.craftbook.steps.find((s) => s.id === 'build');
  expect(build?.gateAttempts).toBeUndefined();
  expect(build?.lastGateReject).toBeUndefined();
  expect(needsHelp).not.toHaveBeenCalled();
});

it('hands the step to a gezel pinned while its role was being resolved', async () => {
  let num = 0;
  tasks.setRoleResolver(async () => {
    await new TaskManager(new Store({ home })).updateStep('fixture', num, 'review', {
      suggestedGezelId: 'user-pick',
    });
    return { gezelId: 'resolver-pick' };
  });
  const activated = vi.fn(async () => {});
  tasks.setStepActivatedHook(activated);
  const task = await tasks.create('fixture', {
    title: 'Pinned',
    assignee: { kind: 'user' },
    steps: [
      { id: 'build', name: 'Build', assignee: { kind: 'user' } },
      { id: 'review', name: 'Review', suggestedRole: 'Reviewer' },
    ],
  });
  num = task.num;

  expect((await tasks.completeStepChecked('fixture', num, 'build')).status).toBe('advanced');

  const stored = (await store.readTask('fixture', num))!;
  expect(stored.craftbook.steps.find((s) => s.id === 'review')?.suggestedGezelId).toBe('user-pick');
  expect(activated).toHaveBeenCalledTimes(1);
  expect(activated).toHaveBeenCalledWith(
    expect.objectContaining({
      newStep: expect.objectContaining({ id: 'review', suggestedGezelId: 'user-pick' }),
    }),
  );
});

it('does not dispatch a step the task left while its role was being resolved', async () => {
  let num = 0;
  tasks.setRoleResolver(async () => {
    await new TaskManager(new Store({ home })).activateStep('fixture', num, 'ship');
    return { gezelId: 'resolver-pick' };
  });
  const activated = vi.fn(async () => {});
  tasks.setStepActivatedHook(activated);
  const task = await tasks.create('fixture', {
    title: 'Jumped',
    assignee: { kind: 'user' },
    steps: [
      { id: 'build', name: 'Build', assignee: { kind: 'user' } },
      { id: 'review', name: 'Review', suggestedRole: 'Reviewer' },
      { id: 'ship', name: 'Ship', assignee: { kind: 'user' } },
    ],
  });
  num = task.num;

  const outcome = await tasks.completeStepChecked('fixture', num, 'build');

  expect(outcome.status).toBe('advanced');
  expect(outcome.task.activeStepId).toBe('ship');
  expect(activated).not.toHaveBeenCalled();
  const stored = (await store.readTask('fixture', num))!;
  expect(stored.activeStepId).toBe('ship');
  expect(stored.craftbook.steps.find((s) => s.id === 'review')?.suggestedGezelId).toBeUndefined();
});

it('does not mistake an older pass completion for a concurrent one', async () => {
  let num = 0;
  let calls = 0;
  tasks.setScriptRunner({
    run: async ({ scriptName }: { scriptName: string }) => {
      calls += 1;
      // The second evaluation races a user jump to another step.
      if (calls === 2) await tasks.activateStep('fixture', num, 'c');
      return scriptRun(scriptName, { decision: 'approve' });
    },
  } as unknown as ScriptRunner);
  const task = await tasks.create('fixture', {
    title: 'Stale stamp',
    assignee: { kind: 'user' },
    steps: [
      {
        id: 'a',
        name: 'A',
        assignee: { kind: 'user' },
        gate: { at: 'completion', scripts: [{ name: 'verify', scope: 'standard' }] } as never,
      },
      { id: 'b', name: 'B', assignee: { kind: 'user' } },
      { id: 'c', name: 'C', assignee: { kind: 'user' } },
    ],
  });
  num = task.num;
  await tasks.completeStepChecked('fixture', num, 'a');
  // Removing the active step re-points the task at the entry step without a
  // fresh activation, so `a` keeps the previous pass's completedAt.
  await tasks.removeStep('fixture', num, 'b');
  const before = (await store.readTask('fixture', num))!;
  expect(before.activeStepId).toBe('a');
  const staleStamp = before.craftbook.steps.find((s) => s.id === 'a')?.completedAt;
  expect(staleStamp).toBeDefined();

  const outcome = await tasks
    .completeStepChecked('fixture', num, 'a')
    .catch((error: unknown) => error);

  expect(outcome).toBeInstanceOf(TaskWriteConflictError);
  const stored = (await store.readTask('fixture', num))!;
  expect(stored.activeStepId).toBe('c');
  expect(stored.craftbook.steps.find((s) => s.id === 'a')?.completedAt).toBe(staleStamp);
});
