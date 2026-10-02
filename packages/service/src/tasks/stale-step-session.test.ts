import type { Task, TaskCraftbookStep } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { staleStepSessionRefusal } from './stale-step-session.js';

const EVALUATE_PASS_1 = '2026-10-01T14:36:09.052Z';

function task(
  activeStepId: string | undefined,
  steps: Array<Partial<TaskCraftbookStep> & { id: string }>,
): Task {
  return {
    projectId: 'office',
    num: 1,
    ref: 'office/1',
    title: 'Monthly Invoice Run',
    status: 'active',
    assignee: { kind: 'user' },
    ...(activeStepId ? { activeStepId } : {}),
    craftbook: {
      id: 'invoice-run',
      name: 'Monthly Invoice Run',
      entryStepId: 'scope',
      steps: steps.map((step) => ({ name: step.id, ...step })),
    },
    createdAt: EVALUATE_PASS_1,
    updatedAt: EVALUATE_PASS_1,
    createdBy: { kind: 'user' },
  } as unknown as Task;
}

const reviewer = {
  gezelId: 'rusudan',
  taskRef: 'office/1',
  stepId: 'evaluate',
  stepActivationId: EVALUATE_PASS_1,
};

describe('staleStepSessionRefusal', () => {
  it("leaves the current pass's session alone", () => {
    const current = task('evaluate', [{ id: 'evaluate', lastActivatedAt: EVALUATE_PASS_1 }]);
    expect(staleStepSessionRefusal(reviewer, current)).toBeNull();
  });

  // The invoice-run incident: evaluate looped back to draft, draft fanned out
  // straight to collect, and the reviewer's leftover turn paused the run.
  it('refuses a session whose step the task has left', () => {
    const movedOn = task('collect', [
      { id: 'collect', suggestedGezelId: 'nicoleta' },
      { id: 'evaluate', lastActivatedAt: EVALUATE_PASS_1 },
    ]);
    const refusal = staleStepSessionRefusal(reviewer, movedOn);
    expect(refusal).toContain('Your step `evaluate` is no longer the active step on office/1');
    expect(refusal).toContain('the task is now on `collect`');
    expect(refusal).toContain("Don't change the task — end your turn.");
    expect(refusal).not.toContain('yours as well');
  });

  it('refuses a session from an earlier pass of a step that is active again', () => {
    const reentered = task('evaluate', [
      { id: 'evaluate', lastActivatedAt: '2026-10-01T15:02:00.000Z' },
    ]);
    const refusal = staleStepSessionRefusal(reviewer, reentered);
    expect(refusal).toContain('the task looped back and a newer pass of that step owns it now');
    expect(refusal).toContain('end your turn');
  });

  it('tells a same-owner session the next step comes back to it after this turn', () => {
    const generalist = task('finish', [
      { id: 'evaluate', lastActivatedAt: EVALUATE_PASS_1 },
      { id: 'finish', suggestedGezelId: 'rusudan' },
    ]);
    expect(staleStepSessionRefusal(reviewer, generalist)).toContain(
      '`finish` is yours as well; the runtime re-engages you with its procedure once this turn ends.',
    );
  });

  it('refuses after the task settled', () => {
    const done = task(undefined, [{ id: 'evaluate', lastActivatedAt: EVALUATE_PASS_1 }]);
    expect(staleStepSessionRefusal(reviewer, done)).toContain(
      'the task has no active step any more',
    );
  });

  it('keeps today’s behavior for unbound sessions, other tasks, and unjudgeable steps', () => {
    const movedOn = task('collect', [{ id: 'collect' }, { id: 'evaluate' }]);
    // The Meester's front-door chat, an ad-hoc session, or one created before
    // activations were recorded.
    expect(staleStepSessionRefusal({ gezelId: 'meester' }, movedOn)).toBeNull();
    expect(
      staleStepSessionRefusal({ taskRef: 'office/1', stepId: 'evaluate' }, movedOn),
    ).toBeNull();
    expect(staleStepSessionRefusal({ ...reviewer, taskRef: 'office/2' }, movedOn)).toBeNull();
    expect(staleStepSessionRefusal(null, movedOn)).toBeNull();
    expect(staleStepSessionRefusal(reviewer, null)).toBeNull();
    // Active, but the step never recorded an activation to compare against.
    expect(staleStepSessionRefusal(reviewer, task('evaluate', [{ id: 'evaluate' }]))).toBeNull();
  });
});
