import { staticCapacityCeilings } from '@bendyline/gezel-inference/internal/providers/native/device-capacity';
import { describe, expect, it } from 'vitest';

const GB = 1024 ** 3;
const unified = (budgetGb: number) => ({
  kind: 'unified' as const,
  budgetBytes: budgetGb * GB,
  fastBytes: budgetGb * GB,
  vramBytes: 0,
});

describe('unified GPU ceiling', () => {
  it('lets a large Linux unified host commit all but the residency reserve', () => {
    // 121.63 GiB DGX Spark: 0.75 x RAM is 91.2 GiB, below the ~95.4 GiB a
    // resident GLM 5.3 Q2 launch asks for. RAM - 24 GiB is 97.6.
    const ram = Math.round(121.63 * GB);
    const { gpuBudgetBytes } = staticCapacityCeilings(unified(105.6), ram, undefined, 'linux');
    expect(gpuBudgetBytes).toBe(ram - 24 * GB);
    expect(gpuBudgetBytes).toBeGreaterThan(95.41 * GB);
  });

  it('keeps macOS on the 0.75 x RAM curve', () => {
    const { gpuBudgetBytes } = staticCapacityCeilings(unified(112), 128 * GB, undefined, 'darwin');
    expect(gpuBudgetBytes).toBe(96 * GB);
  });

  it('keeps small Linux unified hosts on the curve, which is the larger ceiling there', () => {
    const { gpuBudgetBytes } = staticCapacityCeilings(unified(56), 64 * GB, undefined, 'linux');
    expect(gpuBudgetBytes).toBe(48 * GB);
  });

  it('never lets the GPU ceiling exceed the RAM budget', () => {
    const { gpuBudgetBytes } = staticCapacityCeilings(unified(90), 128 * GB, undefined, 'linux');
    expect(gpuBudgetBytes).toBe(90 * GB);
  });
});
