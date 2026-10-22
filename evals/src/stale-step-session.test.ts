import { describe, expect, it } from 'vitest';
import { stepBindingIsStale } from './stale-step-session.ts';

const task = (activeStepId: string, lastActivatedAt: string, status = 'active') =>
  ({
    status,
    activeStepId,
    craftbook: { steps: [{ id: 'report', lastActivatedAt }, { id: 'evaluate' }] },
  }) as never;

const session = (stepActivationId?: string) => ({
  taskRef: 'p/1',
  stepId: 'report',
  ...(stepActivationId ? { stepActivationId } : {}),
});

describe('stepBindingIsStale', () => {
  it('keeps the session serving the current pass live', () => {
    expect(stepBindingIsStale(session('t2'), task('report', 't2'))).toBe(false);
  });

  it('retires an earlier pass of the same step after a review loop', () => {
    // week-plan, 2026-10-21: report pass 1 kept answering after pass 3 began.
    expect(stepBindingIsStale(session('t1'), task('report', 't3'))).toBe(true);
  });

  it('retires a session whose task moved on or finished', () => {
    expect(stepBindingIsStale(session('t2'), task('evaluate', 't2'))).toBe(true);
    expect(stepBindingIsStale(session('t2'), task('report', 't2', 'complete'))).toBe(true);
  });

  it('reads an unbound session, or an unknown task, as live', () => {
    expect(stepBindingIsStale({}, task('report', 't2'))).toBe(false);
    expect(stepBindingIsStale(session(), task('report', 't2'))).toBe(false);
    expect(stepBindingIsStale(session('t1'), null)).toBe(false);
  });
});
