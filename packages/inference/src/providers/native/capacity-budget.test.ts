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

  it('caps the fast pool at what the GPU can reach under Linux GTT, not the admission budget', () => {
    // 32 GiB laptop, 2 GiB carve-out, GTT at its default half of the rest.
    const visible = 30 * GiB;
    const host = { systemRamBytes: visible, gpuVramBytes: 2 * GiB + 15 * GiB, unifiedMemory: true };
    const uncapped = computeCapacityBudget({ ...host, reservedGpuBytes: 2 * GiB });
    const capped = computeCapacityBudget({
      ...host,
      reservedGpuBytes: 2 * GiB,
      gpuAddressableBytes: 2 * GiB + 15 * GiB,
    });
    expect(capped.budgetBytes).toBe(uncapped.budgetBytes);
    expect(uncapped.fastBytes).toBe(uncapped.budgetBytes);
    expect(capped.fastBytes).toBe(usableReservedGpuBytes(17 * GiB));
    expect(capped.fastBytes).toBeLessThan(capped.budgetBytes);
    expect(capped.concurrencySizingBytes).toBeLessThanOrEqual(capped.fastBytes);
  });

  it('never lets a GTT figure raise the fast pool, or touch a discrete card', () => {
    const generous = computeCapacityBudget({
      systemRamBytes: 30 * GiB,
      gpuVramBytes: 2 * GiB,
      unifiedMemory: true,
      gpuAddressableBytes: 64 * GiB,
    });
    expect(generous.fastBytes).toBe(generous.budgetBytes);
    const card = computeCapacityBudget({
      systemRamBytes: 32 * GiB,
      gpuVramBytes: 12 * GiB,
      unifiedMemory: false,
      gpuAddressableBytes: 4 * GiB,
    });
    expect(card.fastBytes).toBe(card.vramBytes);
  });

  it('leaves the display at least 512 MiB of the carve-out', () => {
    expect(usableReservedGpuBytes(512 * MiB)).toBe(0);
    expect(usableReservedGpuBytes(3 * GiB)).toBe(2.5 * GiB);
    expect(usableReservedGpuBytes(16 * GiB)).toBe(16 * GiB - Math.ceil(16 * GiB * 0.05));
    expect(usableReservedGpuBytes(null)).toBe(0);
  });
});
