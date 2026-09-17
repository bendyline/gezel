import { describe, expect, it } from 'vitest';
import type { Task, TaskStatus } from './task.js';
import { taskEffectiveStatus, withEffectiveTaskStatuses } from './task.js';

function task(ref: string, status: TaskStatus, parentTaskRef?: string): Task {
  const [projectId, num] = ref.split('/');
  return {
    projectId: projectId!,
    num: Number(num),
    ref,
    title: ref,
    status,
    assignee: { kind: 'user' },
    craftbook: {
      id: 'test',
      name: 'Test',
      steps: [{ id: 'work', name: 'Work', createdAt: '2026-01-01T00:00:00.000Z' }],
      entryStepId: 'work',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    ...(parentTaskRef ? { parentTaskRef } : {}),
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    createdBy: { kind: 'user' },
  };
}

describe('withEffectiveTaskStatuses', () => {
  it.each(['paused', 'complete', 'canceled'] as const)(
    'inherits a parent %s state without changing the child status',
    (parentStatus) => {
      const parent = task('project/1', parentStatus);
      const child = task('project/2', 'active', parent.ref);
      const projected = withEffectiveTaskStatuses([parent, child]);
      const projectedChild = projected.find((candidate) => candidate.ref === child.ref)!;

      expect(projectedChild.status).toBe('active');
      expect(taskEffectiveStatus(projectedChild)).toBe(parentStatus);
      expect(child.effectiveStatus).toBeUndefined();
    },
  );

  it('recursively follows ancestor state and reveals stored state when ancestors resume', () => {
    const grandparent = task('project/1', 'paused');
    const parent = task('project/2', 'complete', grandparent.ref);
    const child = task('project/3', 'active', parent.ref);

    const held = withEffectiveTaskStatuses([grandparent, parent, child]);
    expect(held.map(taskEffectiveStatus)).toEqual(['paused', 'paused', 'paused']);

    const resumed = withEffectiveTaskStatuses([
      { ...grandparent, status: 'active' },
      parent,
      child,
    ]);
    expect(resumed.map(taskEffectiveStatus)).toEqual(['active', 'complete', 'complete']);
  });

  it('keeps a child own terminal state while its parent is active', () => {
    const parent = task('project/1', 'active');
    const child = task('project/2', 'complete', parent.ref);
    const projected = withEffectiveTaskStatuses([parent, child]);
    expect(taskEffectiveStatus(projected[1]!)).toBe('complete');
  });
});
