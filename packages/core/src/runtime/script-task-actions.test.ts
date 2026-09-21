import { describe, expect, it } from 'vitest';
import type { CreateTaskRequest } from '../schemas/task.js';
import { PortableScriptHost } from './script-host.js';
import { createPortableScriptTaskActions } from './script-tasks.js';
import { PortableTaskRunner } from './task-routes.js';
import { portableFixture } from './test-files.js';

async function fixture() {
  const { store } = portableFixture();
  await store.ensureLayout();
  const runner = new PortableTaskRunner({
    store,
    runStep: async () => {
      throw new Error('Unexpected model dispatch');
    },
  });
  const host = new PortableScriptHost(store);
  host.setTaskActions(createPortableScriptTaskActions(store, runner));
  const context = {
    projectId: 'default',
    signal: new AbortController().signal,
    trigger: { kind: 'manual', userInitiated: true } as const,
  };
  const input: CreateTaskRequest = {
    title: 'Offline script task',
    description: 'Prepare and verify a useful artifact using ordinary offline task transitions.',
    assignee: { kind: 'user' },
    steps: [
      {
        name: 'Prepare',
        terminal: true,
        gate: {
          at: 'completion',
          checks: [{ kind: 'minBytes', file: 'required.md', artifact: true, bytes: 5 }],
        },
      },
    ],
  };
  return { store, runner, host, context, input };
}
describe('script task actions through shared task transitions', () => {
  it('creates, updates, holds and advances ordinary tasks without bypassing their gates', async () => {
    const { store, host, context, input } = await fixture();
    const task = (await host.dispatch(context, 'task.create', { req: input })) as { ref: string };
    expect(
      await host.dispatch(context, 'task.update', {
        ref: task.ref,
        patch: { title: 'Updated by script' },
      }),
    ).toMatchObject({ title: 'Updated by script' });
    expect(await host.dispatch(context, 'task.advance', { ref: task.ref })).toMatchObject({
      status: 'held',
      gate: { decision: 'reject' },
      task: { status: 'active' },
    });
    await store.writeFile('artifacts', 'default', 'required.md', 'Complete');
    expect(await host.dispatch(context, 'task.advance', { ref: task.ref })).toMatchObject({
      status: 'advanced',
      task: { status: 'complete' },
    });
    expect((await store.getTask(task.ref))?.status).toBe('complete');
    await expect(
      host.dispatch(context, 'task.update', { ref: task.ref, patch: { status: 'active' } }),
    ).rejects.toThrow();
  });
  it('rejects lifecycle reentry and SDK-triggered background dispatch before any task mutation', async () => {
    const { store, host, context, input } = await fixture();
    await expect(
      host.dispatch(context, 'task.create', { req: { ...input, dispatchEntry: true } }),
    ).rejects.toThrow('without dispatchEntry');
    expect(await store.listTasks()).toEqual([]);
    const task = await store.createTask('default', input);
    const hook = {
      ...context,
      trigger: {
        kind: 'step',
        taskRef: task.ref,
        stepId: task.activeStepId!,
        moment: 'enter',
      } as const,
    };
    for (const [method, params] of [
      ['task.advance', { ref: task.ref }],
      ['task.update', { ref: task.ref, patch: { title: 'Bad' } }],
      ['task.create', { req: input }],
    ] as const)
      await expect(host.dispatch(hook, method, params)).rejects.toThrow('lifecycle or gate script');
    expect((await store.getTask(task.ref))?.title).toBe(input.title);
    expect((await store.getTask(task.ref))?.activeStepId).toBe(task.activeStepId);
  });
  it('checks current project, role, task and human-step authority for model-triggered scripts', async () => {
    const { store, host, context, input } = await fixture();
    const gezel = await store.createGezel({ name: 'Noor', role: 'Generalist' });
    const task = await store.createTask('default', {
      ...input,
      assignee: { kind: 'gezel', gezelId: gezel.id },
    });
    const other = await store.createTask('default', input);
    const session = await store.createSession({
      gezelId: gezel.id,
      projectId: 'default',
      providerName: 'llama-cpp',
      taskRef: task.ref,
      stepId: task.activeStepId,
    });
    const chat = {
      ...context,
      trigger: { kind: 'chat', gezelId: gezel.id, sessionId: session.id } as const,
    };
    await expect(
      host.dispatch(chat, 'task.update', { ref: other.ref, patch: { title: 'Wrong task' } }),
    ).rejects.toThrow('current task');
    await expect(host.dispatch(chat, 'task.create', { req: input })).rejects.toThrow(
      'current task',
    );
    await expect(host.dispatch(context, 'task.get', { ref: 'outside/1' })).rejects.toThrow(
      'outside',
    );
    const ordinary = await store.createSession({
      gezelId: gezel.id,
      projectId: 'default',
      providerName: 'llama-cpp',
    });
    await expect(
      host.dispatch(
        { ...chat, trigger: { ...chat.trigger, sessionId: ordinary.id } },
        'task.advance',
        { ref: other.ref },
      ),
    ).rejects.toThrow('awaits the user');
    await store.updateProject('default', { status: 'readonly' });
    await expect(
      host.dispatch(context, 'task.update', { ref: task.ref, patch: { title: 'Denied' } }),
    ).rejects.toThrow('does not accept task changes');
  });
  it('cancels a gate child before committing completion and preserves its active step', async () => {
    const { store, host, context, input } = await fixture();
    const task = await store.createTask('default', {
      ...input,
      steps: [
        {
          name: 'Check',
          terminal: true,
          gate: { at: 'completion', scripts: [{ name: 'review', scope: 'project' }] },
        },
      ],
    });
    const controller = new AbortController();
    const blocked = {
      ...context,
      signal: controller.signal,
      runTaskScript: async () => {
        controller.abort();
        throw new Error('Cancelled');
      },
    };
    await expect(host.dispatch(blocked, 'task.advance', { ref: task.ref })).rejects.toThrow(
      'stopped',
    );
    expect((await store.getTask(task.ref))?.activeStepId).toBe(task.activeStepId);
    expect((await store.getTask(task.ref))?.status).toBe('active');
  });
  it('reauthorizes the parent after a gate finishes and before committing the transition', async () => {
    const { store, host, context, input } = await fixture();
    const task = await store.createTask('default', {
      ...input,
      steps: [
        {
          name: 'Check',
          terminal: true,
          gate: { at: 'completion', scripts: [{ name: 'review' }] },
        },
      ],
    });
    let revoked = false;
    await expect(
      host.dispatch(
        {
          ...context,
          authorizeMethod: async () => {
            if (revoked) throw new Error('Script permission revoked');
          },
          runTaskScript: async () => {
            revoked = true;
            return {
              id: 'gate',
              projectId: 'default',
              scriptName: 'review',
              startedAt: new Date().toISOString(),
              status: 'ok',
              inputs: {},
              trigger: {
                kind: 'step',
                taskRef: task.ref,
                stepId: task.activeStepId!,
                moment: 'gate',
              },
              calls: [],
              logs: '',
              output: { decision: 'approve' },
            };
          },
        },
        'task.advance',
        { ref: task.ref },
      ),
    ).rejects.toThrow('permission revoked');
    expect((await store.getTask(task.ref))?.activeStepId).toBe(task.activeStepId);
  });
  it('prevents reassignment while the task has a durable execution owner', async () => {
    const { store, host, context, input } = await fixture();
    const task = await store.createTask('default', input);
    const gezel = await store.createGezel({ name: 'Noor', role: 'Generalist' });
    await store.beginTaskRun(task.ref);
    await expect(
      host.dispatch(context, 'task.update', {
        ref: task.ref,
        patch: { assignee: { kind: 'gezel', gezelId: gezel.id } },
      }),
    ).rejects.toThrow('Pause the task');
    expect((await store.getTask(task.ref))?.assignee.kind).toBe('user');
  });
});
