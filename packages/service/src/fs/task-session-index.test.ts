import { describe, expect, it } from 'vitest';
import { TaskSessionIndex } from './task-session-index.js';

describe('TaskSessionIndex', () => {
  it('maps tasks to sessions and follows rebinding and deletion', () => {
    const index = new TaskSessionIndex();
    index.note('ada', 's1', 'p/1');
    index.note('ada', 's2', 'p/1');
    index.note('boz', 's3', 'p/2');
    index.note('ada', 's4', undefined);
    expect(index.sessionsFor('p/1')).toEqual([
      { gezelId: 'ada', sessionId: 's1' },
      { gezelId: 'ada', sessionId: 's2' },
    ]);
    index.note('ada', 's1', 'p/2');
    index.forget('ada', 's2');
    expect(index.sessionsFor('p/1')).toEqual([]);
    expect(index.sessionsFor('p/2').map((s) => s.sessionId)).toEqual(['s3', 's1']);
    index.note('boz', 's3', undefined);
    expect(index.sessionsFor('p/2').map((s) => s.sessionId)).toEqual(['s1']);
  });

  it('tracks completeness per gezel', () => {
    const index = new TaskSessionIndex();
    expect(index.isComplete('ada')).toBe(false);
    index.markComplete('ada');
    expect(index.isComplete('ada')).toBe(true);
    expect(index.isComplete('boz')).toBe(false);
  });
});
