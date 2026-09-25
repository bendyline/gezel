import { describe, expect, it } from 'vitest';
import { applyGateRejection } from './gate-accounting.js';
import { GATE_FIXTURES } from './gate-fixtures.js';

describe('applyGateRejection', () => {
  it.each(GATE_FIXTURES.map((f) => [f.name, f] as const))('%s', (_name, fixture) => {
    const plan = applyGateRejection({
      step: { id: fixture.stepId, ...fixture.prior },
      gate: fixture.gate,
      verdict: fixture.verdict,
      steps: fixture.steps.map((id) => ({ id })),
    });
    expect(plan).toMatchObject(fixture.expect);
    if (fixture.expect.routeTo === undefined) expect(plan.routeTo).toBeUndefined();
    if (fixture.expect.unknownRoute === undefined) expect(plan.unknownRoute).toBeUndefined();
  });
});
