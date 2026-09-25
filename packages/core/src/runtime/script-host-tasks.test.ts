import { describe, expect, it } from 'vitest';
import { PortableScriptHost } from './script-host.js';
import { portableFixture } from './test-files.js';

async function fixture() {
  const { store } = portableFixture();
  await store.ensureLayout();
  const task = await store.createTask('default', {
    title: 'Useful notes',
    description: 'Read and write useful notes for this offline workflow.',
    steps: [{ name: 'Prepare' }, { name: 'Review' }],
  });
  const context = {
    projectId: 'default',
    signal: new AbortController().signal,
    trigger: {
      kind: 'step' as const,
      taskRef: task.ref,
      stepId: task.activeStepId!,
      moment: 'enter' as const,
    },
  };
  return { store, task, context, host: new PortableScriptHost(store) };
}
describe('portable task SDK', () => {
  it('uses the shared SDK task view and persists ordinary task notes', async () => {
    const { store, task, context, host } = await fixture();
    expect(await host.dispatch(context, 'task.get', { ref: String(task.num) })).toMatchObject({
      ref: task.ref,
    });
    expect(await host.dispatch(context, 'task.currentStep', { ref: task.ref })).toMatchObject({
      id: task.activeStepId,
      status: 'active',
      isActive: true,
    });
    const steps = await host.dispatch(context, 'task.steps', { ref: task.ref });
    expect(steps).toHaveLength(2);
    expect(steps).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ gate: expect.anything() })]),
    );
    await host.dispatch(context, 'task.writeNotes', { ref: task.ref, content: 'Prepared offline' });
    const note = await host.dispatch(context, 'task.appendNote', {
      ref: task.ref,
      text: 'Checked offline',
    });
    expect(note).toMatchObject({ stepId: task.activeStepId, text: 'Checked offline' });
    expect(
      await host.dispatch(context, 'task.readNotes', { ref: task.ref, phaseId: task.activeStepId }),
    ).toBe('Prepared offline\n\nChecked offline');
    expect(await store.listTaskNotes(task.ref)).toHaveLength(2);
  });
  it('enforces task/step/project confinement, cancellation and current activation before note effects', async () => {
    const { store, task, context, host } = await fixture();
    const other = await store.createTask('default', {
      title: 'Other task',
      description: 'A different task should not receive this hook note.',
      steps: [{ name: 'Start' }],
    });
    await expect(
      host.dispatch(context, 'task.appendNote', { ref: other.ref, text: 'Wrong task' }),
    ).rejects.toThrow('current task');
    await expect(
      host.dispatch(context, 'task.appendNote', {
        ref: task.ref,
        text: 'Wrong step',
        stepId: task.craftbook.steps[1]!.id,
      }),
    ).rejects.toThrow('current task');
    await expect(host.dispatch(context, 'task.get', { ref: 'outside/1' })).rejects.toThrow();
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(
      host.dispatch({ ...context, signal: cancelled.signal }, 'task.writeNotes', {
        ref: task.ref,
        content: 'Cancelled',
      }),
    ).rejects.toThrow('cancelled');
    await store.completeTaskStep(task.ref, task.activeStepId!);
    await expect(
      host.dispatch(context, 'task.writeNotes', { ref: task.ref, content: 'Stale step' }),
    ).rejects.toThrow('stopped or changed');
    expect(await store.listTaskNotes(task.ref)).toEqual([]);
  });
});
