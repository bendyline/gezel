import { describe, expect, it } from 'vitest';
import { isGatedStep } from './phase-gate.js';

const steps = (...ids: string[]) => ids.map((id) => ({ id }));

describe('isGatedStep', () => {
  it('flags a step that loops back to an earlier step (build-loop evaluate → build)', () => {
    const all = steps('design', 'build', 'evaluate', 'finish');
    expect(isGatedStep({ id: 'evaluate', next: 'build' }, all)).toBe(true);
  });

  it('flags a self-looping step', () => {
    expect(isGatedStep({ id: 'b', next: 'b' }, steps('a', 'b'))).toBe(true);
  });

  it('flags a step via a backward branch goto (reviewer-loop revise → critique)', () => {
    const all = steps('draft', 'critique', 'revise', 'publish');
    const revise = {
      id: 'revise',
      branches: [{ when: { op: 'always' as const }, goto: 'critique' }],
    };
    expect(isGatedStep(revise, all)).toBe(true);
  });

  it('flags a step with an onExit gate even when every edge points forward (ship run-tests)', () => {
    const all = steps('preflight', 'run-tests', 'review', 'halt');
    const runTests = { id: 'run-tests', next: 'review', onExit: { name: 'run-tests' } };
    expect(isGatedStep(runTests, all)).toBe(true);
  });

  it('does NOT flag a purely forward/linear step (investigate)', () => {
    const all = steps('gather', 'search', 'reproduce', 'trace');
    expect(isGatedStep({ id: 'search', next: 'reproduce' }, all)).toBe(false);
    expect(isGatedStep({ id: 'gather', next: 'search' }, all)).toBe(false);
  });

  it('does NOT flag a forward branch (qa smoke → halt later in the list)', () => {
    const all = steps('smoke', 'exercise', 'edges', 'triage', 'summary', 'halt');
    const smoke = {
      id: 'smoke',
      next: 'exercise',
      branches: [{ when: { op: 'always' as const }, goto: 'halt' }],
    };
    expect(isGatedStep(smoke, all)).toBe(false);
  });
});
