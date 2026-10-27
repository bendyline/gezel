import { describe, expect, it } from 'vitest';
import { TaskStatusIndex } from './task-status-index.js';

const at = (minute: number) => `2026-10-27T10:${String(minute).padStart(2, '0')}:00.000Z`;

describe('TaskStatusIndex', () => {
  it('buckets live statuses, follows a task between them, and drops it when it closes', () => {
    const index = new TaskStatusIndex();
    index.note({ projectId: 'p', num: 1, status: 'active', updatedAt: at(1) });
    index.note({ projectId: 'p', num: 3, status: 'active', updatedAt: at(3) });
    index.note({ projectId: 'p', num: 2, status: 'draft', updatedAt: at(2) });
    index.note({ projectId: 'q', num: 4, status: 'active', updatedAt: at(4) });
    expect(index.nums('p', 'active')).toEqual([3, 1]);
    expect(index.nums('p', 'draft')).toEqual([2]);
    expect(index.nums('q', 'active')).toEqual([4]);

    index.note({ projectId: 'p', num: 2, status: 'active', updatedAt: at(5) });
    index.note({ projectId: 'p', num: 3, status: 'complete', updatedAt: at(6) });
    expect(index.nums('p', 'active')).toEqual([2, 1]);
    expect(index.nums('p', 'draft')).toEqual([]);
    expect(index.summary('p')).toEqual({ taskCount: 3, latestUpdatedAt: at(6) });
  });

  it('forgets a task that is gone', () => {
    const index = new TaskStatusIndex();
    index.note({ projectId: 'p', num: 1, status: 'paused', updatedAt: at(1) });
    index.forget('p', 1);
    expect(index.nums('p', 'paused')).toEqual([]);
    expect(index.summary('p').taskCount).toBe(0);
    expect(index.summary('missing')).toEqual({ taskCount: 0 });
  });

  it('is complete only once a full listing says so', () => {
    const index = new TaskStatusIndex();
    index.note({ projectId: 'p', num: 1, status: 'active', updatedAt: at(1) });
    expect(index.isComplete('p')).toBe(false);
    index.markComplete('p');
    expect(index.isComplete('p')).toBe(true);
    expect(index.isComplete('q')).toBe(false);
  });
});
