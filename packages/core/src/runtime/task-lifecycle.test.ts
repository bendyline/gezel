import { describe, expect, it, vi } from 'vitest';
import type { ScriptRun } from '../schemas/script.js';
import { PortableStore } from './store.js';
import { PortableTaskRunner } from './task-routes.js';
import { portableFixture } from './test-files.js';

async function fixture() {
  const fixture = portableFixture();
  await fixture.store.ensureLayout();
  const gezel = await fixture.store.createGezel({ name: 'Noor', role: 'Generalist' });
  const input = {
    title: 'Offline workflow',
    description: 'Prepare a useful report, check its result, and preserve the finished work.',
    assignee: { kind: 'gezel' as const, gezelId: gezel.id },
  };
  return { ...fixture, gezel, input };
}
async function idle(runner: PortableTaskRunner) {
  for (let i = 0; i < 200 && runner.isBusy(); i++)
    await new Promise((resolve) => setTimeout(resolve, 2));
  expect(runner.isBusy()).toBe(false);
}
const hook = { name: 'storeRecords', scope: 'standard' as const };
function result(name: string, output: unknown = { ok: true }): ScriptRun {
  return {
    id: crypto.randomUUID(),
    projectId: 'default',
    scriptName: name,
    startedAt: new Date().toISOString(),
    status: 'ok',
    trigger: { kind: 'manual', userInitiated: true },
    inputs: {},
    calls: [],
    logs: '',
    output,
  };
}
describe('portable foreground lifecycle execution', () => {
  it.each(['paused', 'canceled'] as const)(
    'stops execution even if saving %s fails, and leaves interrupted work recoverable',
    async (status) => {
      const { store, files, options, input } = await fixture();
      const task = await store.createTask('default', {
        ...input,
        steps: [{ name: 'Prepare', onEnter: hook, terminal: true }],
      });
      let entered!: () => void;
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let signal: AbortSignal | undefined;
      const runStep = vi.fn(async () => {});
      const cancelStep = vi.fn(async () => {});
      const runner = new PortableTaskRunner({
        store,
        runStep,
        cancelStep,
        runScript: async (_task, _step, _moment, _ref, current) => {
          signal = current;
          entered();
          await new Promise((resolve) =>
            current.addEventListener('abort', resolve, { once: true }),
          );
          return { ...result(hook.name), status: 'error', error: 'Stopped by the user' };
        },
      });
      await runner.run(task.ref);
      await ready;
      // Fail the real transaction commit point after the hook's durable start.
      files.fault = (operation, path) =>
        operation === 'write' && path === '.transactions/pending.json';
      try {
        await expect(runner.pause(task.ref, status)).rejects.toThrow('Disk unavailable');
        expect(signal?.aborted).toBe(true);
        expect(cancelStep).toHaveBeenCalledOnce();
        expect(runStep).not.toHaveBeenCalled();
      } finally {
        files.fault = undefined;
        runner.cancelActive();
        await idle(runner);
      }
      const reopened = new PortableStore(options);
      const recovered = new PortableTaskRunner({ store: reopened, runStep });
      await recovered.initialize();
      expect((await reopened.getTask(task.ref))?.status).toBe('paused');
      expect(runStep).not.toHaveBeenCalled();
    },
  );

  it('enforces the deadline while a hook is still running and cancels the foreground host', async () => {
    const { store, input } = await fixture();
    const task = await store.createTask('default', {
      ...input,
      steps: [{ name: 'Work', onEnter: hook, terminal: true }],
    });
    const runStep = vi.fn(async () => {});
    const cancelStep = vi.fn(async () => {});
    const runner = new PortableTaskRunner({
      store,
      runStep,
      cancelStep,
      maxDurationMs: 50,
      runScript: async (_task, _step, _moment, _ref, signal) => {
        await new Promise<void>((_resolve, reject) => {
          const abort = () => reject(new Error('Hook stopped at the task deadline'));
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
        });
        return result(hook.name);
      },
    });
    await runner.run(task.ref);
    await idle(runner);
    expect(cancelStep).toHaveBeenCalledOnce();
    expect(runStep).not.toHaveBeenCalled();
    expect((await store.getTask(task.ref))?.status).toBe('paused');
    expect((await store.getTaskLifecycle(task.ref))?.entries.at(-1)?.state).toBe('error');
  });
  it('journals hooks before effects, walks assignees across steps, and stops at the human handoff', async () => {
    const { store, input, gezel } = await fixture();
    const other = await store.createGezel({ name: 'Iris', role: 'Writer' });
    const task = await store.createTask('default', {
      ...input,
      steps: [
        { name: 'Prepare', onEnter: hook, onExit: hook },
        { name: 'Review', assignee: { kind: 'gezel', gezelId: other.id } },
        { name: 'Approve', assignee: { kind: 'user' } },
      ],
    });
    const seen: string[] = [];
    const moments: string[] = [];
    const runner = new PortableTaskRunner({
      store,
      runStep: async (current) => {
        const step = current.craftbook.steps.find((item) => item.id === current.activeStepId)!;
        seen.push(step.assignee?.kind === 'gezel' ? step.assignee.gezelId : gezel.id);
        await runner.complete(task.ref, step.id);
      },
      runScript: async (current, _step, moment, ref) => {
        expect((await store.getTaskLifecycle(current.ref))?.entries.at(-1)?.state).toBe('started');
        moments.push(moment);
        await store.writeFile('artifacts', 'default', `${moment}.md`, 'Saved');
        return result(ref.name);
      },
    });
    await runner.run(task.ref);
    await idle(runner);
    expect(seen).toEqual([gezel.id, other.id]);
    expect(moments).toEqual(['onEnter', 'onExit']);
    expect((await store.getTask(task.ref))?.activeStepId).toBe('approve');
    expect((await store.getTask(task.ref))?.status).toBe('active');
    await expect(runner.run(task.ref)).rejects.toThrow('awaits the user');
  });
  it('retains completed setup hooks across an explicit model retry, and bounds cyclic workflows', async () => {
    const { store, input } = await fixture();
    const task = await store.createTask('default', {
      ...input,
      steps: [{ name: 'Work', onEnter: hook, next: 'work' }],
    });
    let fail = true;
    const runScript = vi.fn(async () => result(hook.name));
    const runner = new PortableTaskRunner({
      store,
      maxSteps: 2,
      runScript,
      runStep: async (current) => {
        if (fail) throw new Error('Model stopped');
        await runner.complete(current.ref, current.activeStepId!);
      },
    });
    await runner.run(task.ref);
    await idle(runner);
    expect((await store.getTask(task.ref))?.status).toBe('paused');
    await store.setTaskStatus(task.ref, 'active');
    fail = false;
    await runner.run(task.ref, true);
    await idle(runner);
    // Setup was skipped for the resumed activation and ran for the next loop activation only.
    expect(runScript).toHaveBeenCalledTimes(2);
    expect((await store.getTask(task.ref))?.status).toBe('paused');
  });
  it('never replays an OS-interrupted hook implicitly and records an explicit retry separately', async () => {
    const { store, options, input } = await fixture();
    const task = await store.createTask('default', {
      ...input,
      steps: [{ name: 'Work', onEnter: hook, terminal: true }],
    });
    await store.beginTaskRun(task.ref);
    await store.beginTaskHook(task.ref, task.activeStepId!, 'onEnter', 0, hook);
    await store.writeFile('artifacts', 'default', 'prior.md', 'Possible prior side effect');
    const reopened = new PortableStore(options);
    const runScript = vi.fn(async () => result(hook.name));
    const runner = new PortableTaskRunner({ store: reopened, runScript, runStep: async () => {} });
    await runner.initialize();
    expect((await reopened.getTask(task.ref))?.status).toBe('paused');
    expect(runScript).not.toHaveBeenCalled();
    await reopened.setTaskStatus(task.ref, 'active');
    await runner.run(task.ref);
    await idle(runner);
    expect(runScript).not.toHaveBeenCalled();
    await reopened.setTaskStatus(task.ref, 'active');
    await runner.run(task.ref, true);
    await idle(runner);
    expect(runScript).toHaveBeenCalledTimes(1);
    expect(
      (await reopened.getTaskLifecycle(task.ref))?.entries.map((entry) => entry.state),
    ).toEqual(['started', 'ok']);
  });
  it('preserves a user cancellation when a cyclic workflow reaches its step limit', async () => {
    const { store, input } = await fixture();
    const task = await store.createTask('default', {
      ...input,
      steps: [{ name: 'Work', next: 'work' }],
    });
    const runner = new PortableTaskRunner({
      store,
      maxSteps: 1,
      runStep: async (current) => {
        await runner.complete(current.ref, current.activeStepId!);
      },
      shouldContinue: async () => {
        await store.setTaskStatus(task.ref, 'canceled');
        return true;
      },
    });
    await runner.run(task.ref);
    await idle(runner);
    expect((await store.getTask(task.ref))?.status).toBe('canceled');
  });
  it('honors shared setup auto-advance predicates without invoking a model', async () => {
    const { store, input } = await fixture();
    const task = await store.createTask('default', {
      ...input,
      steps: [
        {
          name: 'Prepare',
          terminal: true,
          onEnter: { ...hook, autoAdvanceWhen: { op: 'equals', field: 'count', value: 0 } },
        },
      ],
    });
    const runStep = vi.fn(async () => {});
    const runner = new PortableTaskRunner({
      store,
      runStep,
      runScript: async () => result(hook.name, { count: 0 }),
    });
    await runner.run(task.ref);
    await idle(runner);
    expect(runStep).not.toHaveBeenCalled();
    expect((await store.getTask(task.ref))?.status).toBe('complete');
  });
  it('runs human-step setup once after transition, then waits without dispatching a model', async () => {
    const { store, input } = await fixture();
    const task = await store.createTask('default', {
      ...input,
      steps: [
        { name: 'Prepare', onEnter: { ...hook, autoAdvanceOnSuccess: true } },
        { name: 'Approve', terminal: true, assignee: { kind: 'user' }, onEnter: hook },
      ],
    });
    const runStep = vi.fn(async () => {});
    const runScript = vi.fn(async () => result(hook.name));
    const runner = new PortableTaskRunner({ store, runStep, runScript });
    await runner.run(task.ref);
    await idle(runner);
    const current = (await store.getTask(task.ref))!;
    expect(current.activeStepId).toBe(task.craftbook.steps[1]!.id);
    expect(current.status).toBe('active');
    expect(runStep).not.toHaveBeenCalled();
    expect(runScript).toHaveBeenCalledTimes(2);
    await runner.initialize();
    await runner.run(task.ref);
    await idle(runner);
    expect(runScript).toHaveBeenCalledTimes(2);
    expect(runStep).not.toHaveBeenCalled();
    await runner.complete(task.ref, current.activeStepId!);
    expect((await store.getTask(task.ref))?.status).toBe('complete');
  });
  it('holds human setup auto-advance behind its gate and any newly opened question', async () => {
    const { store, input, gezel } = await fixture();
    const task = await store.createTask('default', {
      ...input,
      steps: [
        {
          name: 'Approve',
          terminal: true,
          assignee: { kind: 'user' },
          onEnter: { ...hook, autoAdvanceOnSuccess: true },
          gate: { at: 'completion', checks: [{ kind: 'minBytes', file: 'required.md', bytes: 5 }] },
        },
      ],
    });
    const runStep = vi.fn(async () => {});
    const gate = vi.fn(async () => ({ approved: false, message: 'Required file missing' }));
    const runner = new PortableTaskRunner({
      store,
      runStep,
      evaluateGate: gate,
      runScript: async () => result(hook.name),
    });
    await runner.run(task.ref);
    await idle(runner);
    expect((await store.getTask(task.ref))?.status).toBe('active');
    expect(gate).toHaveBeenCalledOnce();
    expect(runStep).not.toHaveBeenCalled();
    const session = await store.createSession({
      gezelId: gezel.id,
      projectId: 'default',
      providerName: 'llama-cpp',
    });
    const question = await store.askQuestion({
      gezelId: gezel.id,
      sessionId: session.id,
      projectId: 'default',
      taskRef: task.ref,
      prompt: 'Is this ready?',
    });
    const completed = await runner.complete(task.ref, task.activeStepId!);
    expect(completed.gate?.decision).toBe('reject');
    expect(completed.gate?.message).toContain('outstanding question');
    expect((await store.getQuestion(question.question.id))?.answer).toBeUndefined();
    expect(gate).toHaveBeenCalledOnce();
  });
  it('preserves an explicit task cancellation while its exit hook is stopping', async () => {
    const { store, input } = await fixture();
    const task = await store.createTask('default', {
      ...input,
      steps: [{ name: 'Finish', terminal: true, onExit: hook }],
    });
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const runner = new PortableTaskRunner({
      store,
      runStep: async (current) => {
        await runner.complete(current.ref, current.activeStepId!);
      },
      runScript: async (_task, _step, _moment, _ref, signal) => {
        entered();
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
        return { ...result(hook.name), status: 'error', error: 'Cancelled' };
      },
    });
    await runner.run(task.ref);
    await ready;
    await runner.pause(task.ref, 'canceled');
    await idle(runner);
    expect((await store.getTask(task.ref))?.status).toBe('canceled');
    expect((await store.getTaskLifecycle(task.ref))?.entries.at(-1)?.state).toBe('error');
  });
  it.each(['gate', 'exit'])(
    'holds completion when a question arrives during %s work',
    async (moment) => {
      const { store, input, gezel } = await fixture();
      const task = await store.createTask('default', {
        ...input,
        steps: [
          {
            name: 'Review',
            terminal: true,
            onExit: hook,
            gate: { at: 'completion', scripts: [hook] },
          },
        ],
      });
      const session = await store.createSession({
        gezelId: gezel.id,
        projectId: 'default',
        providerName: 'llama-cpp',
      });
      const ask = () =>
        store.askQuestion({
          gezelId: gezel.id,
          sessionId: session.id,
          projectId: 'default',
          taskRef: task.ref,
          prompt: 'Confirm this before finishing?',
        });
      const exit = vi.fn(async () => {
        if (moment === 'exit') await ask();
        return result(hook.name);
      });
      const runner = new PortableTaskRunner({
        store,
        runStep: async () => {},
        runScript: exit,
        evaluateGate: async () => {
          if (moment === 'gate') await ask();
          return { approved: true };
        },
      });
      const completed = await runner.complete(task.ref, task.activeStepId!);
      expect(completed.gate?.decision).toBe('reject');
      expect(completed.gate?.message).toContain('outstanding question');
      expect(exit).toHaveBeenCalledTimes(moment === 'gate' ? 0 : 1);
      expect((await store.getTask(task.ref))?.activeStepId).toBe(task.activeStepId);
      expect((await store.getTask(task.ref))?.craftbook.steps[0]?.gateAttempts).toBeUndefined();
    },
  );
  it('cancels a lifecycle hook and never starts its model step afterward', async () => {
    const { store, input } = await fixture();
    const task = await store.createTask('default', {
      ...input,
      steps: [{ name: 'Work', onEnter: hook, terminal: true, assignee: { kind: 'user' } }],
    });
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const runStep = vi.fn(async () => {});
    const runner = new PortableTaskRunner({
      store,
      runStep,
      runScript: async (_task, _step, _moment, _ref, signal) => {
        entered();
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
        return { ...result(hook.name), status: 'error', error: 'Cancelled' };
      },
    });
    await runner.run(task.ref);
    await ready;
    runner.cancelActive();
    await idle(runner);
    expect(runStep).not.toHaveBeenCalled();
    expect((await store.getTask(task.ref))?.status).toBe('paused');
    expect((await store.getTaskLifecycle(task.ref))?.entries[0]?.state).toBe('error');
  });
});
