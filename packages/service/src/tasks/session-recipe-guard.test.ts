import type { Task, TaskCraftbookStep } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import {
  sessionRecipeRefusal,
  stepOrderRefusal,
  stepPatchRefusal,
  stepRemovalRefusal,
} from './session-recipe-guard.js';

const GATE = { checks: [{ kind: 'fileExists', path: 'out/report.md' }] };

function task(status: string, steps: TaskCraftbookStep[]): Task {
  return {
    status,
    craftbook: { id: 'cb', name: 'Recipe', entryStepId: steps[0]!.id, steps },
  } as unknown as Task;
}

const draft = (): TaskCraftbookStep[] => [
  { id: 'draft', name: 'Draft', gate: GATE } as unknown as TaskCraftbookStep,
  { id: 'review', name: 'Review' } as unknown as TaskCraftbookStep,
];
const withApproval = (): TaskCraftbookStep[] => [
  { id: 'draft', name: 'Draft' } as unknown as TaskCraftbookStep,
  { id: 'approve', name: 'Approve', assignee: { kind: 'user' } } as unknown as TaskCraftbookStep,
  { id: 'publish', name: 'Publish' } as unknown as TaskCraftbookStep,
];

describe('session recipe guard', () => {
  it('leaves a draft nobody started, with no step of the person’s, open to the gezel writing it', () => {
    const t = task('draft', draft());
    expect(stepRemovalRefusal(t, 'review')).toBeNull();
    expect(stepPatchRefusal(t, 'draft', { gate: null })).toBeNull();
    expect(stepOrderRefusal(t, ['review', 'draft'])).toBeNull();
  });

  it('never lets a gezel change, remove or route around the person’s own step', () => {
    for (const status of ['draft', 'active']) {
      const t = task(status, withApproval());
      expect(stepRemovalRefusal(t, 'approve')).toMatch(/person's own step/);
      expect(
        stepPatchRefusal(t, 'approve', { assignee: { kind: 'gezel', gezelId: 'gz-1' } }),
      ).toMatch(/person's own step/);
      expect(stepPatchRefusal(t, 'draft', { next: 'publish' })).toMatch(/where "Draft" leads/);
      expect(stepOrderRefusal(t, ['draft', 'publish', 'approve'])).toMatch(/order/);
    }
  });

  it('lets a started task gain checks and steps but not lose or change them', () => {
    const t = task('active', draft());
    expect(stepPatchRefusal(t, 'draft', { gate: null })).toMatch(/keeps the checks/);
    expect(
      stepPatchRefusal(t, 'draft', {
        gate: { checks: [{ kind: 'fileExists', path: 'x.md' }] },
      } as never),
    ).toMatch(/keeps the checks/);
    expect(stepPatchRefusal(t, 'review', { gate: GATE } as never)).toBeNull();
    expect(stepPatchRefusal(t, 'review', { prompt: 'Read it twice.' } as never)).toBeNull();
    expect(stepRemovalRefusal(t, 'review')).toMatch(/keeps its steps/);
  });

  it('refuses a replaced recipe that drops a check or adds a step that ends the task early', () => {
    const t = task('active', draft());
    const steps = draft();
    expect(
      sessionRecipeRefusal(t, {
        entryStepId: 'draft',
        steps: [{ ...steps[0]!, gate: undefined } as TaskCraftbookStep, steps[1]!],
      }),
    ).toMatch(/keeps the checks/);
    expect(
      sessionRecipeRefusal(t, {
        entryStepId: 'draft',
        steps: [
          steps[0]!,
          { id: 'done', name: 'Done', terminal: true } as TaskCraftbookStep,
          steps[1]!,
        ],
      }),
    ).toMatch(/cannot end the task/);
    expect(
      sessionRecipeRefusal(t, {
        entryStepId: 'draft',
        steps: [...steps, { id: 'extra', name: 'Extra' } as TaskCraftbookStep],
      }),
    ).toBeNull();
    expect(sessionRecipeRefusal(t, { entryStepId: 'review', steps })).toMatch(/first step/);
  });
});
