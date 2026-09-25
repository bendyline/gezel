import { describe, expect, it, vi } from 'vitest';
import { CompleteStepResponseSchema, type CreateTaskRequest } from '../schemas/task.js';
import { PortableStore } from './store.js';
import { type PortableGateScript, evaluatePortableTaskGate } from './task-gates.js';
import { PortableTaskRunner } from './task-routes.js';
import { portableFixture } from './test-files.js';

const ref = { name: 'checkContains', scope: 'standard' as const };
async function fixture(steps?: CreateTaskRequest['steps']) {
  const value = portableFixture();
  await value.store.ensureLayout();
  const task = await value.store.createTask('default', {
    title: 'Gate protocol',
    description: 'Produce and review the project report with a deterministic completion check.',
    steps: steps ?? [
      { id: 'draft', name: 'Draft', gate: { at: 'completion', scripts: [ref] } },
      { id: 'review', name: 'Review' },
      { id: 'finish', name: 'Finish', terminal: true },
    ],
  });
  return { ...value, task, step: task.craftbook.steps[0]! };
}
function runner(store: PortableStore, script: PortableGateScript, runScript = vi.fn()) {
  return new PortableTaskRunner({
    store,
    runStep: async () => {},
    runScript,
    evaluateGate: (task, step) => evaluatePortableTaskGate(store, task, step, script),
  });
}

describe('portable shared gate-script contract', () => {
  it('uses the last supplied approval goto and handoff and commits a receiving-step note', async () => {
    const { store, options, task, step } = await fixture();
    step.gate = { at: 'completion', onApprove: 'review', scripts: [ref, ref, ref] };
    const script = vi
      .fn<PortableGateScript>()
      .mockResolvedValueOnce({
        status: 'ok',
        output: { decision: 'approve', goto: 'review', handoff: { message: 'First draft' } },
      })
      .mockResolvedValueOnce({
        status: 'ok',
        output: {
          decision: 'approve',
          goto: 'finish',
          handoff: { message: 'Review these findings', params: { count: 3 } },
        },
      })
      .mockResolvedValueOnce({ status: 'ok', output: { decision: 'approve' } });
    const gate = await evaluatePortableTaskGate(store, task, step, script);
    expect(gate).toMatchObject({
      approved: true,
      next: 'finish',
      handoff: { message: 'Review these findings', params: { count: 3 } },
    });
    const completed = await store.completeTaskStep(task.ref, 'draft', { gate });
    expect(completed.task.activeStepId).toBe('finish');
    expect(completed.task.lastGateHandoff).toMatchObject({
      fromStepId: 'draft',
      toStepId: 'finish',
      message: 'Review these findings',
      params: { count: 3 },
    });
    const reopened = new PortableStore(options);
    expect((await reopened.getTask(task.ref))?.lastGateHandoff).toEqual(
      completed.task.lastGateHandoff,
    );
    expect(await reopened.listTaskNotes(task.ref)).toEqual([
      expect.objectContaining({
        stepId: 'finish',
        text: '# Handoff from gate on "Draft"\n\nReview these findings\n\n- count: 3',
      }),
    ]);
  });

  it('short-circuits on the first prescribed reject, honoring goto without completing the rejected step', async () => {
    const { store, task, step } = await fixture();
    step.gate = { at: 'completion', scripts: [ref, ref] };
    const script = vi.fn<PortableGateScript>().mockResolvedValue({
      status: 'ok',
      output: {
        decision: 'reject',
        message: 'Revise the evidence',
        goto: 'review',
        handoff: { message: 'Must not publish a rejection handoff' },
      },
    });
    const gate = await evaluatePortableTaskGate(store, task, step, script);
    expect(script).toHaveBeenCalledOnce();
    expect(gate).toEqual({ approved: false, message: 'Revise the evidence', next: 'review' });
    const completed = await store.completeTaskStep(task.ref, 'draft', { gate });
    expect(completed.task.activeStepId).toBe('review');
    expect(completed.task.craftbook.steps[0]?.completedAt).toBeUndefined();
    expect(completed.gate).toMatchObject({ decision: 'reject', attempt: 1, paused: false });
    expect(completed.task.lastGateHandoff).toBeUndefined();
  });

  it.each([
    ['absent result', { status: 'ok' }],
    ['missing reject guidance', { status: 'ok', output: { decision: 'reject' } }],
    ['blank reject guidance', { status: 'ok', output: { decision: 'reject', message: '  ' } }],
    ['invalid decision', { status: 'ok', output: { decision: 'passed' } }],
    [
      'broken script',
      {
        id: 'audit-broken',
        status: 'error',
        error: 'Missing SDK export',
        logs: 'saved diagnostic',
      },
    ],
    ['unknown route', { status: 'ok', output: { decision: 'approve', goto: 'missing' } }],
    [
      'unknown reject route',
      { status: 'ok', output: { decision: 'reject', message: 'Repair', goto: 'missing' } },
    ],
  ])(
    'pauses %s without spending a deliverable attempt or running exit effects',
    async (_name, result) => {
      const { store, options, task } = await fixture();
      await store.completeTaskStep(task.ref, 'draft', {
        gate: { approved: false, message: 'First real rejection' },
      });
      const exit = vi.fn();
      const script = vi.fn<PortableGateScript>().mockResolvedValue(result);
      const completed = CompleteStepResponseSchema.parse(
        await runner(store, script, exit).complete(task.ref, 'draft'),
      );
      expect(completed.gate).toMatchObject({
        decision: 'reject',
        infrastructureError: true,
        paused: true,
        attempt: 1,
      });
      expect(completed.gate?.scriptRuns).toHaveLength(1);
      expect(completed.task.status).toBe('paused');
      expect(completed.task.activeStepId).toBe('draft');
      expect(exit).not.toHaveBeenCalled();
      const reopened = new PortableStore(options);
      expect((await reopened.getTask(task.ref))?.craftbook.steps[0]?.gateAttempts).toBe(1);
      expect((await reopened.listTaskNotes(task.ref)).at(-1)?.text).toContain(
        'No completion attempt was consumed',
      );
      if ('id' in result)
        expect(completed.gate?.scriptRuns?.[0]).toMatchObject({
          runId: result.id,
          logsTail: 'saved diagnostic',
        });
    },
  );

  it('treats executor exceptions and unsupported predicates as infrastructure faults', async () => {
    const { store, task, step } = await fixture();
    expect(
      await evaluatePortableTaskGate(store, task, step, async () => {
        throw new Error('Worker unavailable');
      }),
    ).toMatchObject({
      approved: false,
      infrastructureError: true,
      scriptRuns: [{ scriptName: ref.name, error: 'Worker unavailable' }],
    });
    expect(await evaluatePortableTaskGate(store, task, step)).toMatchObject({
      approved: false,
      infrastructureError: true,
    });
    step.gate = { at: 'completion', checks: [{ kind: 'nodeRuns', file: 'script.js' }] };
    expect(await evaluatePortableTaskGate(store, task, step)).toMatchObject({
      approved: false,
      infrastructureError: true,
    });
  });

  it('rejects unresolved launch tokens before reading a file or executing a script', async () => {
    const { store, task, step } = await fixture();
    step.gate = {
      at: 'completion',
      scripts: [{ ...ref, inputs: { pattern: 'Evidence: {{source}}' } }],
    };
    const script = vi.fn<PortableGateScript>();
    expect(await evaluatePortableTaskGate(store, task, step, script)).toMatchObject({
      approved: false,
      infrastructureError: true,
      message: expect.stringContaining('{{source}}'),
    });
    expect(script).not.toHaveBeenCalled();
    const read = vi.spyOn(store, 'readFileBytes');
    step.gate = undefined;
    step.advanceWhen = { file: '{{output}}.md' };
    expect(await evaluatePortableTaskGate(store, task, step)).toMatchObject({
      approved: false,
      infrastructureError: true,
      message: expect.stringContaining('{{output}}'),
    });
    expect(read).not.toHaveBeenCalled();
  });

  it('keeps the schema contract: next is not an alias for goto', async () => {
    const { store, task, step } = await fixture();
    const gate = await evaluatePortableTaskGate(store, task, step, async () => ({
      status: 'ok',
      output: { decision: 'approve', next: 'finish' },
    }));
    const completed = await store.completeTaskStep(task.ref, 'draft', { gate });
    expect(completed.task.activeStepId).toBe('review');
  });

  it('re-enters an explicit self-reject route with new hook checkpoints and a retained bounded budget', async () => {
    const { store, task } = await fixture([
      {
        id: 'draft',
        name: 'Draft',
        terminal: true,
        onEnter: ref,
        onExit: ref,
        gate: { at: 'completion', scripts: [ref], onReject: 'draft', maxAttempts: 2 },
      },
    ]);
    const entered = await store.beginTaskHook(task.ref, 'draft', 'onEnter', 0, ref);
    await store.finishTaskHook(task.ref, entered.activationId, entered.id, {
      id: 'setup-first',
      status: 'ok',
    });
    const original = await store.getTaskLifecycle(task.ref);
    const script = vi.fn<PortableGateScript>().mockResolvedValue({
      status: 'ok',
      output: { decision: 'reject', message: 'Add supporting evidence' },
    });
    const taskRunner = runner(store, script);
    const first = await taskRunner.complete(task.ref, 'draft');
    expect(first.gate).toMatchObject({ attempt: 1, paused: false });
    const next = await store.getTaskLifecycle(task.ref);
    expect(next?.activationId).not.toBe(original?.activationId);
    expect(next?.entries).toEqual([]);
    const secondEntry = await store.beginTaskHook(task.ref, 'draft', 'onEnter', 0, ref);
    expect(secondEntry.skipped).toBe(false);
    await store.finishTaskHook(task.ref, secondEntry.activationId, secondEntry.id, {
      id: 'setup-second',
      status: 'ok',
    });
    const second = await taskRunner.complete(task.ref, 'draft');
    expect(second.gate).toMatchObject({ attempt: 2, paused: true });
    expect((await store.getTaskLifecycle(task.ref))?.activationId).toBe(next?.activationId);
    expect(second.task.craftbook.steps[0]?.completedAt).toBeUndefined();
  });

  it('resets the receiving step’s prior rejection budget after an approved transition', async () => {
    const { store, task } = await fixture();
    await store.completeTaskStep(task.ref, 'draft', {
      gate: { approved: false, message: 'Repair once' },
    });
    await store.completeTaskStep(task.ref, 'draft', { gate: { approved: true } });
    const returned = await store.completeTaskStep(task.ref, 'review', { next: 'draft' });
    expect(returned.task.craftbook.steps[0]?.gateAttempts).toBeUndefined();
    const rejected = await store.completeTaskStep(task.ref, 'draft', {
      gate: { approved: false, message: 'A new pass needs work' },
    });
    expect(rejected.gate?.attempt).toBe(1);
  });

  it('resolves the assignee after a rejected gate routes to a different step', async () => {
    const { store, task } = await fixture([
      { id: 'draft', name: 'Draft', gate: { at: 'completion', scripts: [ref] } },
      { id: 'review', name: 'Review', terminal: true, suggestedRole: 'Reviewer' },
    ]);
    const reviewer = await store.createGezel({ name: 'Eva', role: 'Reviewer' });
    const resolveStepRole = vi.fn(async () => reviewer.id);
    const taskRunner = new PortableTaskRunner({
      store,
      runStep: async () => {},
      resolveStepRole,
      evaluateGate: (task, step) =>
        evaluatePortableTaskGate(store, task, step, async () => ({
          status: 'ok',
          output: { decision: 'reject', message: 'Review evidence first', goto: 'review' },
        })),
    });
    const completed = await taskRunner.complete(task.ref, 'draft');
    expect(resolveStepRole).toHaveBeenCalledWith('default', 'Reviewer');
    expect(completed.task.craftbook.steps[1]?.suggestedGezelId).toBe(reviewer.id);
    expect(completed.gate?.decision).toBe('reject');
  });
});
