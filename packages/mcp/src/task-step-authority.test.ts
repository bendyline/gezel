import { describe, expect, it } from 'vitest';
import { taskStepMutationRejection } from './task-step-authority.js';

describe('taskStepMutationRejection', () => {
  it('allows the session to write while its step is active', () => {
    expect(
      taskStepMutationRejection({
        taskRef: 'default/10',
        sessionStepId: 'research',
        activeStepId: 'research',
        transitionCompleted: false,
      }),
    ).toBeNull();
  });

  it('rejects writes immediately after this session advances its step', () => {
    const message = taskStepMutationRejection({
      taskRef: 'default/10',
      sessionStepId: 'research',
      activeStepId: 'research',
      transitionCompleted: true,
    });
    expect(message).toContain('no longer owns project writes');
    expect(message).toContain('Stop this turn and yield');
  });

  it('rejects a resumed session whose snapshotted step is no longer active', () => {
    const message = taskStepMutationRejection({
      taskRef: 'default/10',
      sessionStepId: 'research',
      activeStepId: 'outline',
      transitionCompleted: false,
    });
    expect(message).toContain('active step is now "outline"');
  });

  it('tells a session that also owns the new active step to end its turn, not to yield to someone else', () => {
    const message = taskStepMutationRejection({
      taskRef: 'default/10',
      sessionStepId: 'evaluate',
      activeStepId: 'repair',
      transitionCompleted: false,
      activeStepOwnedBySession: true,
    });
    expect(message).toContain('active step is now "repair"');
    expect(message).toContain('That step is yours as well');
    expect(message).not.toContain("yield to the active step's gezel");
  });

  it('does not constrain ordinary non-task sessions', () => {
    expect(
      taskStepMutationRejection({
        taskRef: '',
        sessionStepId: '',
        transitionCompleted: true,
      }),
    ).toBeNull();
  });
});
