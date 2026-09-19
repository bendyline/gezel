import { describe, expect, it } from 'vitest';
import { withRepairPolicy } from './repair-policy.ts';
import type { EvalScenario } from './types.ts';

const craftbookShaped = {
  id: 'craftbook-sample',
  description: 'a craftbook scenario with the book default policy',
  repairPolicy: undefined,
} as unknown as EvalScenario;

const hermetic = {
  id: 'schema-migration',
  description: 'a scenario that never declared a repair policy',
} as unknown as EvalScenario;

describe('withRepairPolicy', () => {
  it('returns the scenario itself when no override is requested', () => {
    expect(withRepairPolicy(craftbookShaped, undefined)).toBe(craftbookShaped);
  });

  it('overrides a craftbook scenario whose book left the policy unset', () => {
    const out = withRepairPolicy(craftbookShaped, 'runtime');
    expect(out).not.toBe(craftbookShaped);
    expect(out.repairPolicy).toBe('runtime');
    expect(out.id).toBe('craftbook-sample');
  });

  it('returns the same object when the policy already matches', () => {
    const runtime = { ...craftbookShaped, repairPolicy: 'runtime' } as EvalScenario;
    expect(withRepairPolicy(runtime, 'runtime')).toBe(runtime);
    expect(withRepairPolicy(runtime, 'harness').repairPolicy).toBe('harness');
  });

  it('applies to a scenario that never declared a policy of its own', () => {
    // The runner's re-engage nudge fired on a Meester-driven authoring
    // scenario under a `runtime` campaign because the override used to skip
    // scenarios without the key (breadth run, 2026-09-18).
    const out = withRepairPolicy(hermetic, 'runtime');
    expect(out).not.toBe(hermetic);
    expect(out.repairPolicy).toBe('runtime');
  });
});
