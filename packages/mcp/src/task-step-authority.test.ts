import { describe, expect, it } from 'vitest';
import {
  sessionReboundToCurrentPass,
  staleTaskStepRefusal,
  taskStepMutationRejection,
} from './task-step-authority.js';

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

describe('staleTaskStepRefusal', () => {
  const apiError = (details: unknown) =>
    Object.assign(new Error('Gezel API error 403'), { details });

  it('returns the daemon hint for a stale step pass', () => {
    const hint =
      "Your step `evaluate` is no longer the active step on p/1 — the task is now on `collect`. Don't change the task — end your turn.";
    expect(staleTaskStepRefusal(apiError({ error: 'stale_task_step', hint }))).toBe(hint);
  });

  it('ignores every other refusal', () => {
    expect(staleTaskStepRefusal(apiError({ error: 'forbidden', hint: 'nope' }))).toBeNull();
    expect(staleTaskStepRefusal(apiError({ error: 'stale_task_step' }))).toBeNull();
    expect(staleTaskStepRefusal(new Error('boom'))).toBeNull();
    expect(staleTaskStepRefusal(undefined)).toBeNull();
  });
});

describe('sessionReboundToCurrentPass', () => {
  const pass1 = '2026-10-08T07:30:00.000Z';
  const pass2 = '2026-10-08T07:51:29.600Z';

  it('keeps the latch for the turn that advanced a self-looping step', () => {
    // The step re-activated as pass 2; the session is still bound to pass 1.
    expect(
      sessionReboundToCurrentPass({
        sessionStepId: 'oversight',
        activeStepId: 'oversight',
        activeStepActivation: pass2,
        sessionActivation: pass1,
      }),
    ).toBe(false);
  });

  it('ends the latch once a dispatch binds the session to the new pass', () => {
    expect(
      sessionReboundToCurrentPass({
        sessionStepId: 'oversight',
        activeStepId: 'oversight',
        activeStepActivation: pass2,
        sessionActivation: pass2,
      }),
    ).toBe(true);
  });

  it('never for another step, or a pass nobody recorded', () => {
    expect(
      sessionReboundToCurrentPass({
        sessionStepId: 'evaluate',
        activeStepId: 'collect',
        activeStepActivation: pass2,
        sessionActivation: pass2,
      }),
    ).toBe(false);
    expect(
      sessionReboundToCurrentPass({
        sessionStepId: 'oversight',
        activeStepId: 'oversight',
        activeStepActivation: undefined,
        sessionActivation: undefined,
      }),
    ).toBe(false);
  });
});
