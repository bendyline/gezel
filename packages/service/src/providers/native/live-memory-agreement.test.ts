/**
 * Planning and device admission must read the SAME live-memory number.
 *
 * The 2026-09-08 incident: on a 16 GiB Mac, `availableSystemRamBytes()` (free
 * + inactive + speculative + purgeable + file-backed) reported 11.33 GiB while
 * the admission ledger's darwin-only sample (free + file-backed + purgeable)
 * reported 5.89 GiB from the same `vm_stat` seconds apart. The context planner
 * sized gemma4-e4b-q4's full 128k window at 9.70 GiB against the first number;
 * admission refused it against the second, then polled an unchanged request
 * every 500 ms for its full five-minute budget before failing. Nothing was
 * holding the missing 5 GiB except the disagreement.
 *
 * These tests pin the relationship rather than either number: whatever the
 * host reports, a plan the clamp accepts is a plan admission accepts.
 */

import { totalmem } from 'node:os';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ available: 0 }));
vi.mock('./capacity-broker.js', async (original) => ({
  ...(await original<typeof import('./capacity-broker.js')>()),
  availableSystemRamBytes: () => mocks.available,
}));
vi.mock('./measured-budget.js', () => ({
  measuredCapacityBudget: async () => ({
    kind: 'unified' as const,
    budgetBytes: 11.2 * 1024 ** 3,
    fastBytes: 11.2 * 1024 ** 3,
    vramBytes: 0,
    ramShareBytes: 11.2 * 1024 ** 3,
    concurrencySizingBytes: 11.2 * 1024 ** 3,
  }),
}));

import { clampCtxTokensForMemory, liveRamOsReserveBytes } from './capacity-broker.js';
import { sampleDeviceCapacity } from './device-capacity.js';

const GIB = 1024 ** 3;

describe('liveRamOsReserveBytes', () => {
  it('scales with the host between a 2 GB floor and a 4 GB cap', () => {
    expect(liveRamOsReserveBytes(8 * GIB)).toBe(2 * GIB);
    expect(liveRamOsReserveBytes(16 * GIB)).toBe(2 * GIB);
    expect(liveRamOsReserveBytes(32 * GIB)).toBe(3.2 * GIB);
    expect(liveRamOsReserveBytes(128 * GIB)).toBe(4 * GIB);
  });
});

describe('planning and admission agree on live memory', () => {
  it('admits against the same reading the planner sizes against', async () => {
    mocks.available = 11.33 * GIB;
    const sample = await sampleDeviceCapacity();
    expect(sample.availableBytes).toBe(11.33 * GIB - liveRamOsReserveBytes(totalmem()));
  });

  it('clamps the incident launch to something admission accepts', async () => {
    mocks.available = 11.33 * GIB;
    const sample = await sampleDeviceCapacity();

    // gemma4-e4b-q4: 6.11 GiB of weights, 28,672 bytes of KV per token, and a
    // 128,000-token native window — 9.70 GiB all in.
    const weightsResidentBytes = 6.11 * GIB;
    const kvBytesPerToken = 28_672;
    const plan = clampCtxTokensForMemory({
      requestedPerTurnCtxTokens: 128_000,
      slots: 1,
      kvBytesPerToken,
      weightsResidentBytes,
      budgetBytes: 11.2 * GIB,
      freeSystemRamBytes: mocks.available,
      vramBytes: 0,
    });

    expect(plan.clamped).toBe(true);
    const plannedBytes = weightsResidentBytes + plan.perTurnCtxTokens * kvBytesPerToken;
    expect(plannedBytes).toBeLessThanOrEqual(sample.availableBytes!);
    // Trimmed, not refused: the window shrinks, the model still runs.
    expect(plan.perTurnCtxTokens).toBeGreaterThan(32_000);
  });

  it('holds back strictly more than admission does, so a plan never lands on the boundary', () => {
    const base = {
      requestedPerTurnCtxTokens: 128_000,
      slots: 1,
      kvBytesPerToken: 28_672,
      weightsResidentBytes: 6.11 * GIB,
      budgetBytes: 64 * GIB,
      freeSystemRamBytes: 11.33 * GIB,
      vramBytes: 0,
    };
    const atAdmissionReserve = clampCtxTokensForMemory({
      ...base,
      osReserveBytes: liveRamOsReserveBytes(totalmem()),
    });
    const planned = clampCtxTokensForMemory(base);
    expect(planned.perTurnCtxTokens).toBeLessThan(atAdmissionReserve.perTurnCtxTokens);
  });

  it('leaves the budget in charge when the host has memory to spare', () => {
    const plan = clampCtxTokensForMemory({
      requestedPerTurnCtxTokens: 32_768,
      slots: 1,
      kvBytesPerToken: 28_672,
      weightsResidentBytes: 6.11 * GIB,
      budgetBytes: 11.2 * GIB,
      freeSystemRamBytes: 64 * GIB,
      vramBytes: 0,
    });
    expect(plan.clamped).toBe(false);
    expect(plan.perTurnCtxTokens).toBe(32_768);
  });
});
