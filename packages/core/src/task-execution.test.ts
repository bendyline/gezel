import { describe, expect, it } from 'vitest';
import type { Task, TaskCraftbookStep } from './schemas/task.js';
import { isOwnerStep, stepOwnerGezelId, taskActiveAssignee } from './task-execution.js';

const step = (over: Partial<TaskCraftbookStep> = {}): TaskCraftbookStep =>
  ({ id: 'owner-review', name: 'Owner Review', ...over }) as TaskCraftbookStep;

const task = (s: TaskCraftbookStep, assignee: Task['assignee']): Task =>
  ({
    ref: 'default/2',
    assignee,
    activeStepId: s.id,
    craftbook: { steps: [s] },
  }) as unknown as Task;

describe('stepOwnerGezelId', () => {
  it('gives an owner step to no gezel, whatever else is on record', () => {
    const owner = step({ assignee: { kind: 'user' }, suggestedGezelId: 'omroeper' });
    expect(isOwnerStep(owner)).toBe(true);
    expect(stepOwnerGezelId(task(owner, { kind: 'gezel', gezelId: 'kylian' }), owner)).toBe(
      undefined,
    );
    // The portable runtime reads the same step as the person's.
    expect(taskActiveAssignee(task(owner, { kind: 'gezel', gezelId: 'kylian' }))).toEqual({
      kind: 'user',
    });
  });

  it('resolves a gezel step as before: step, then role, then task', () => {
    const t = (s: TaskCraftbookStep) => task(s, { kind: 'gezel', gezelId: 'kylian' });
    const pinned = step({ assignee: { kind: 'gezel', gezelId: 'dina' } });
    expect(stepOwnerGezelId(t(pinned), pinned)).toBe('dina');
    const suggested = step({ suggestedGezelId: 'omroeper' });
    expect(stepOwnerGezelId(t(suggested), suggested)).toBe('omroeper');
    const bare = step();
    expect(stepOwnerGezelId(t(bare), bare)).toBe('kylian');
    expect(isOwnerStep(bare)).toBe(false);
  });
});
