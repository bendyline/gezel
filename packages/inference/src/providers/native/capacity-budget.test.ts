import { afterEach, describe, expect, it } from 'vitest';
import {
  computeCapacityBudget,
  setDetectedGpuVramBytes,
  usableReservedGpuBytes,
} from './capacity-budget.js';

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
// What a 16 GiB AMD laptop's OS sees with `carveOut` set aside for the GPU,
// less the usual few hundred MiB of other firmware reservations.
const visibleWith = (carveOut: number) => 16 * GiB - carveOut - 200 * MiB;
const integrated = (carveOut: number) =>
  computeCapacityBudget({
    systemRamBytes: visibleWith(carveOut),
    gpuVramBytes: carveOut,
    unifiedMemory: true,
    reservedGpuBytes: carveOut,
  });

afterEach(() => setDetectedGpuVramBytes(null));

describe('an integrated GPU with a firmware carve-out', () => {
  it('budgets the same however the 16 GiB is split between the OS and the GPU', () => {
    const three = integrated(3 * GiB);
    const eight = integrated(8 * GiB);
    expect(eight.budgetBytes).toBe(three.budgetBytes);
    expect(eight.budgetBytes).toBe(11.5 * GiB - 200 * MiB);
    // The carve-out counted nowhere, raising it to 8 GiB cut the budget to ~3.8 GiB.
    const uncredited = computeCapacityBudget({
      systemRamBytes: visibleWith(8 * GiB),
      gpuVramBytes: 8 * GiB,
      unifiedMemory: true,
    });
    expect(uncredited.budgetBytes).toBe(4 * GiB - 200 * MiB);
  });

  it('stays a unified host whose fast pool is the whole budget', () => {
    const eight = integrated(8 * GiB);
    expect(eight.kind).toBe('unified');
    expect(eight.vramBytes).toBe(7.5 * GiB);
    expect(eight.ramShareBytes).toBe(4 * GiB - 200 * MiB);
    expect(eight.fastBytes).toBe(eight.budgetBytes);
  });

  it('is never credited on a discrete or CPU-only host', () => {
    const cpu = computeCapacityBudget({
      systemRamBytes: 16 * GiB,
      gpuVramBytes: null,
      unifiedMemory: false,
      reservedGpuBytes: 8 * GiB,
    });
    expect(cpu.vramBytes).toBe(0);
    expect(cpu.budgetBytes).toBe(Math.floor(16 * GiB * 0.6));
  });

  it('applies a published carve-out only to callers that do not describe the host', () => {
    setDetectedGpuVramBytes(null, true, 8 * GiB);
    expect(computeCapacityBudget({ systemRamBytes: visibleWith(8 * GiB) }).vramBytes).toBe(
      7.5 * GiB,
    );
    // A caller stating the host shape stays deterministic.
    expect(
      computeCapacityBudget({ systemRamBytes: visibleWith(8 * GiB), unifiedMemory: true })
        .vramBytes,
    ).toBe(0);
  });

  it('leaves the display at least 512 MiB of the carve-out', () => {
    expect(usableReservedGpuBytes(512 * MiB)).toBe(0);
    expect(usableReservedGpuBytes(3 * GiB)).toBe(2.5 * GiB);
    expect(usableReservedGpuBytes(16 * GiB)).toBe(16 * GiB - Math.ceil(16 * GiB * 0.05));
    expect(usableReservedGpuBytes(null)).toBe(0);
  });
});
