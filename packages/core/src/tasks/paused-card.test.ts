import { describe, expect, it } from 'vitest';
import { TaskPausedReasonSchema } from '../schemas/question.js';
import { taskPausedCardText } from './paused-card.js';

describe('taskPausedCardText', () => {
  it('names the task and step in plain words', () => {
    expect(
      taskPausedCardText({
        title: 'Night shift: Test Coverage Review',
        stepName: 'Scope the coverage standard',
        reason: 'gate_infrastructure',
      }),
    ).toBe(
      `"Night shift: Test Coverage Review" stopped at "Scope the coverage standard". Gezel couldn't check this step's work, so it stopped instead of guessing. The problem is in Gezel or the craftbook, not the work, so trying again may not help. Open the task to see what happened.`,
    );
  });

  it('reads without a step', () => {
    expect(taskPausedCardText({ title: 'Weekly review', reason: 'budget_exhausted' })).toBe(
      '"Weekly review" stopped. It ran longer than it is allowed to without finishing. Open the task to see what happened.',
    );
  });

  it('never shows ids, tokens or tool names for any reason', () => {
    for (const reason of TaskPausedReasonSchema.options) {
      const text = taskPausedCardText({ title: 'T', stepName: 'S', reason });
      expect(text).not.toMatch(/\{\{|`|_|checks\[|gate/i);
    }
  });
});
