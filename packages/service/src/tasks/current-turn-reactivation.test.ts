import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../fs/store.js';
import {
  type CurrentTurnReactivationDeps,
  followCurrentTurnReactivation,
} from './current-turn-reactivation.js';
import { TaskManager, stepOwnerGezelId } from './manager.js';
import { TaskRunner } from './runner.js';

/**
 * A generalist owner keeps one session busy from step to step, so the runner
 * still tracks an earlier pass's dispatch for a step when a review gate routes
 * the task back to it. Adopting that dispatch for the new activation made the
 * runner drop the step's real dispatch as a duplicate.
 */

let home: string;
let store: Store;
let tasks: TaskManager;
let runner: TaskRunner;
let dispatches: Array<{ stepId: string }>;
let cancels: Array<{
  sessionId: string;
  pass?: { taskRef: string; stepId: string; activationAt?: string };
}>;
let adoptStepActivation: Mock<CurrentTurnReactivationDeps['chat']['adoptStepActivation']>;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-current-turn-reactivation-'));
  store = new Store({ home });
  await store.ensureLayout();
  await store.createGezel({ name: 'Kiki', role: 'Fact Checker' });
  await store.createProject({ name: 'p1' });
  tasks = new TaskManager(store);
  dispatches = [];
  cancels = [];
  runner = new TaskRunner({
    store,
    dispatcher: {
      // Every step lands in the owner's one session, which never goes idle
      // between the ticks below.
      startHandoffSession: async (args) => {
        dispatches.push({ stepId: args.stepId });
        return { sessionId: 'owner-session' };
      },
      cancelHandoffSession: async (sessionId, pass) => {
        cancels.push({ sessionId, ...(pass ? { pass } : {}) });
        return { cancelled: false };
      },
      isHandoffSessionActive: () => true,
      resolveProviderName: async () => 'copilot',
      getProvider: () => null,
    },
  });
  tasks.setStepActivatedHook(async ({ task, newStep }) => {
    const owner = stepOwnerGezelId(task, newStep);
    if (!owner) return;
    runner.enqueueHandoff({
      gezelId: owner,
      projectId: task.projectId,
      taskRef: task.ref,
      stepId: newStep.id,
      ...(newStep.lastActivatedAt ? { activationAt: newStep.lastActivatedAt } : {}),
      fromGezelId: owner,
    });
  });
  adoptStepActivation = vi.fn();
  tasks.setCurrentTurnStepReactivatedHook((ctx) =>
    followCurrentTurnReactivation({ chat: { adoptStepActivation }, runner }, ctx),
  );
});

afterEach(async () => {
  await runner.stop();
  await rm(home, { recursive: true, force: true });
});

describe('followCurrentTurnReactivation', () => {
  it('dispatches a step a review gate routed back to, though its earlier pass is still tracked', async () => {
    const task = await tasks.create('p1', {
      title: 'Review loop',
      assignee: { kind: 'gezel', gezelId: 'kiki' },
      executionMode: 'generalist',
      steps: [
        { id: 'report', name: 'Report', prompt: 'Write report.md.', next: 'evaluate' },
        {
          id: 'evaluate',
          name: 'Evaluate',
          prompt: 'Write verdict.md.',
          gate: {
            at: 'completion' as const,
            checks: [{ kind: 'notContains' as const, file: 'verdict.md', pattern: 'FAIL' }],
            onReject: 'report',
            maxAttempts: 3,
          },
        },
      ],
      entryStepId: 'report',
      createdBy: { kind: 'user' },
    });
    const firstReportPass = (await store.readTask('p1', task.num))?.craftbook.steps[0]
      ?.lastActivatedAt;
    runner.enqueueHandoff({
      gezelId: 'kiki',
      projectId: 'p1',
      taskRef: task.ref,
      stepId: 'report',
      kind: 'entry',
    });
    await runner.tick();
    await tasks.completeStepChecked('p1', task.num, 'report', undefined, { cause: 'model' });
    await runner.tick();
    expect(dispatches.map((d) => d.stepId)).toEqual(['report', 'evaluate']);

    // The review fails while its turn is still running and routes back.
    await store.writeProjectWorkspaceFile('p1', 'verdict.md', 'Citations: FAIL');
    await new Promise((resolve) => setTimeout(resolve, 5));
    await tasks.completeStepChecked('p1', task.num, 'evaluate', undefined, { cause: 'model' });
    expect((await store.readTask('p1', task.num))?.activeStepId).toBe('report');
    expect(adoptStepActivation).not.toHaveBeenCalled();

    await runner.tick();
    expect(dispatches.map((d) => d.stepId)).toEqual(['report', 'evaluate', 'report']);
    // The earlier pass's dispatch is retired with its own identity, so the
    // chat side can tell it from the turn the session serves now.
    expect(cancels).toContainEqual({
      sessionId: 'owner-session',
      pass: { taskRef: task.ref, stepId: 'report', activationAt: firstReportPass },
    });
  });

  it('keeps a self-loop with the turn that triggered it', async () => {
    const task = await tasks.create('p1', {
      title: 'Self loop',
      assignee: { kind: 'gezel', gezelId: 'kiki' },
      executionMode: 'generalist',
      steps: [
        {
          id: 'build',
          name: 'Build',
          prompt: 'Write index.html.',
          gate: {
            at: 'completion' as const,
            checks: [{ kind: 'contains' as const, file: 'index.html', pattern: 'install' }],
            onReject: 'build',
            maxAttempts: 4,
          },
        },
      ],
      entryStepId: 'build',
      createdBy: { kind: 'user' },
    });
    runner.enqueueHandoff({
      gezelId: 'kiki',
      projectId: 'p1',
      taskRef: task.ref,
      stepId: 'build',
      kind: 'entry',
    });
    await runner.tick();
    await store.writeProjectWorkspaceFile('p1', 'index.html', '<p>draft</p>');
    await new Promise((resolve) => setTimeout(resolve, 5));
    await tasks.completeStepChecked('p1', task.num, 'build', undefined, { cause: 'model' });

    expect(adoptStepActivation).toHaveBeenCalledTimes(1);
    await runner.tick();
    // The live dispatch followed the new activation: no second dispatch, no cancel.
    expect(dispatches.map((d) => d.stepId)).toEqual(['build']);
    expect(cancels).toEqual([]);
  });

  it('stops every turn on a task that was paused, whichever step its session serves now', async () => {
    const task = await tasks.create('p1', {
      title: 'Paused run',
      assignee: { kind: 'gezel', gezelId: 'kiki' },
      executionMode: 'generalist',
      steps: [{ id: 'build', name: 'Build', prompt: 'Write index.html.' }],
      entryStepId: 'build',
      createdBy: { kind: 'user' },
    });
    runner.enqueueHandoff({
      gezelId: 'kiki',
      projectId: 'p1',
      taskRef: task.ref,
      stepId: 'build',
      kind: 'entry',
    });
    await runner.tick();
    await tasks.setStatus('p1', task.num, 'paused');
    await runner.tick();
    expect(cancels).toEqual([{ sessionId: 'owner-session' }]);
  });
});
