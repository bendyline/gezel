import { describe, expect, it } from 'vitest';
import { bumpStepActivation } from './step-activation.js';
import { resolveNextStep } from './step-routing.js';

const steps = [
  { id: 'build', next: 'review' },
  {
    id: 'review',
    branches: [{ when: { op: 'equals' as const, field: 'ok', value: true }, goto: 'done' }],
  },
  { id: 'polish' },
  { id: 'done', terminal: true },
];

describe('resolveNextStep', () => {
  it.each([
    [
      'an explicit jump wins',
      { currentId: 'build', override: 'polish', gateGoto: 'done' },
      { kind: 'advance', to: 'polish' },
    ],
    [
      "'next' is not a jump",
      { currentId: 'build', override: 'next' },
      { kind: 'advance', to: 'review' },
    ],
    [
      'a gate route beats the declared approval route',
      { currentId: 'build', gateGoto: 'done', gateOnApprove: 'polish' },
      { kind: 'advance', to: 'done' },
    ],
    [
      'the approval route beats the declared next',
      { currentId: 'build', gateOnApprove: 'polish' },
      { kind: 'advance', to: 'polish' },
    ],
    [
      "a host's auto-advance route sits after the gate",
      { currentId: 'build', advanceWhenGoto: 'done' },
      { kind: 'advance', to: 'done' },
    ],
    ['a terminal step ends the book', { currentId: 'done' }, { kind: 'terminate' }],
    [
      'a branch predicate routes on the exit output',
      { currentId: 'review', branchOutput: { ok: true } },
      { kind: 'advance', to: 'done' },
    ],
    [
      'no branch match falls through to the following step',
      { currentId: 'review', branchOutput: { ok: false } },
      { kind: 'advance', to: 'polish' },
    ],
    [
      'a last step without next terminates',
      { currentId: 'polish', steps: steps.slice(0, 3) },
      { kind: 'terminate' },
    ],
    [
      'a route to an undeclared step is invalid',
      { currentId: 'build', override: 'ghost' },
      { kind: 'invalid', to: 'ghost' },
    ],
  ] as const)('%s', (_name, input, expected) => {
    expect(resolveNextStep({ steps, ...input })).toEqual(expected);
  });
});

describe('bumpStepActivation', () => {
  const base = [
    { id: 'a', name: 'A', completedAt: 'x', gateAttempts: 2, attemptCount: 1 },
    { id: 'b', name: 'B' },
  ] as never[];
  it('counts the activation and clears the previous pass', () => {
    const a = (bumpStepActivation(base, 'a', 't') as Array<Record<string, unknown>>)[0]!;
    expect(a).toMatchObject({ attemptCount: 2, lastActivatedAt: 't' });
    expect(a).not.toHaveProperty('completedAt');
    expect(a).not.toHaveProperty('gateAttempts');
  });
  it('keeps the gate budget for a self-loop', () => {
    const a = (
      bumpStepActivation(base, 'a', 't', { preserveGateBudget: true }) as Array<
        Record<string, unknown>
      >
    )[0]!;
    expect(a.gateAttempts).toBe(2);
  });
});
