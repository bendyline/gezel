import { describe, expect, it } from 'vitest';
import { TaskLineageIndex } from './task-lineage-index.js';

describe('TaskLineageIndex', () => {
  it('maps parents to children and follows a child that changes parent', () => {
    const index = new TaskLineageIndex();
    index.note({ projectId: 'p', num: 1 });
    index.note({ projectId: 'p', num: 3, parentTaskRef: 'p/1' });
    index.note({ projectId: 'p', num: 2, parentTaskRef: 'p/1' });
    index.note({ projectId: 'q', num: 2, parentTaskRef: 'p/1' });
    expect(index.childNums('p', 'p/1')).toEqual([2, 3]);
    expect(index.childNums('q', 'p/1')).toEqual([2]);

    index.note({ projectId: 'p', num: 3, parentTaskRef: 'p/2' });
    index.note({ projectId: 'p', num: 2 });
    expect(index.childNums('p', 'p/1')).toEqual([]);
    expect(index.childNums('p', 'p/2')).toEqual([3]);
  });

  it('is complete only once a full listing says so', () => {
    const index = new TaskLineageIndex();
    index.note({ projectId: 'p', num: 2, parentTaskRef: 'p/1' });
    expect(index.isComplete('p')).toBe(false);
    index.markComplete('p');
    expect(index.isComplete('p')).toBe(true);
    expect(index.isComplete('q')).toBe(false);
  });
});
