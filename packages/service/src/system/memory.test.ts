import { describe, expect, it } from 'vitest';
import type { MemoryProfile } from './memory.js';
import {
  memoryProfileForLlamaGpu,
  parseNvidiaMemoryProbe,
  sampleMachineMemoryUsage,
  summarizeResidentModels,
} from './memory.js';

const GiB = 1024 ** 3;

describe('parseNvidiaMemoryProbe', () => {
  it('keeps a GeForce discrete when its VRAM is as large as system RAM', () => {
    expect(parseNvidiaMemoryProbe('NVIDIA GeForce RTX 5060 Ti, 16384\n')).toEqual({
      vramBytes: 16 * GiB,
      memoryKind: 'discrete',
      deviceNames: ['NVIDIA GeForce RTX 5060 Ti'],
    });
  });

  it('recognizes the known NVIDIA unified-memory device family', () => {
    expect(parseNvidiaMemoryProbe('NVIDIA GB10, 122880\n')).toMatchObject({
      memoryKind: 'unified',
      deviceNames: ['NVIDIA GB10'],
    });
  });
});

function profile(overrides: Partial<MemoryProfile> = {}): MemoryProfile {
  return {
    platform: 'linux',
    totalRamBytes: 64 * GiB,
    gpuVramBytes: 24 * GiB,
    gpuMemoryKind: 'discrete',
    source: 'gpu-nvidia',
    usableBytes: 22 * GiB,
    budgetBytes: 60 * GiB,
    gpuVendor: 'nvidia',
    ...overrides,
  };
}

describe('memoryProfileForLlamaGpu', () => {
  it('does not add a Surface-class integrated GPU shared allocation to system RAM', () => {
    const result = memoryProfileForLlamaGpu('win32', 32 * GiB, {
      vramBytes: 12 * GiB,
      name: 'Intel(R) Graphics',
      vendor: 'intel',
      memoryKind: 'integrated',
    });

    expect(result).toMatchObject({
      source: 'gpu-integrated',
      gpuMemoryKind: 'integrated',
      gpuVramBytes: 12 * GiB,
      usableBytes: 16 * GiB,
    });
    // One 32-GiB pool at the ordinary 70% unified broker ceiling. The old discrete
    // path incorrectly produced ~30.6 GiB by adding 95% of the same 12 GiB.
    expect(result.budgetBytes).toBe(Math.floor(32 * GiB * 0.7));
  });

  it('still adds real discrete VRAM to the system-RAM share', () => {
    const result = memoryProfileForLlamaGpu('linux', 32 * GiB, {
      vramBytes: 12 * GiB,
      name: 'Intel Arc A770 Graphics',
      vendor: 'intel',
      memoryKind: 'discrete',
    });
    expect(result.source).toBe('gpu-vulkan');
    expect(result.gpuMemoryKind).toBe('discrete');
    expect(result.budgetBytes).toBeGreaterThan(19.2 * GiB);
  });

  it('trusts an explicitly discrete device even when VRAM equals system RAM', () => {
    const result = memoryProfileForLlamaGpu('linux', 16 * GiB, {
      vramBytes: 16 * GiB,
      name: 'NVIDIA GeForce RTX 5060 Ti',
      vendor: 'nvidia',
      memoryKind: 'discrete',
    });
    expect(result.gpuMemoryKind).toBe('discrete');
    expect(result.usableBytes).toBe(Math.floor(16 * GiB * 0.95));
    expect(result.budgetBytes).toBeGreaterThan(16 * GiB);
  });

  it('keeps a large non-Mac unified accelerator distinct from a consumer iGPU', () => {
    const result = memoryProfileForLlamaGpu('linux', 121 * GiB, {
      vramBytes: 119 * GiB,
      name: 'NVIDIA GB10',
      vendor: 'nvidia',
      memoryKind: 'unknown',
    });
    expect(result.gpuMemoryKind).toBe('unified');
    expect(result.source).toBe('gpu-vulkan');
    expect(result.budgetBytes).toBeLessThanOrEqual(96 * GiB);
  });
});

describe('sampleMachineMemoryUsage', () => {
  it('uses main memory for Apple/UMA and attributes resident engines plus daemon RSS', () => {
    const usage = sampleMachineMemoryUsage({
      profile: profile({
        platform: 'darwin',
        gpuVramBytes: null,
        source: 'darwin-unified',
      }),
      engineCommittedBytes: 10 * GiB,
      engineBudgetBytes: 38 * GiB,
      engineModelWeightsBytes: 8 * GiB,
      serviceRssBytes: 2 * GiB,
      freeRamBytes: 20 * GiB,
      sampledAt: 'now',
    });

    expect(usage).toEqual({
      kind: 'unified',
      totalBytes: 64 * GiB,
      usedBytes: 44 * GiB,
      gezelBytesEstimated: 12 * GiB,
      gezelBytesObserved: null,
      gezelInfraBytes: 2 * GiB,
      gezelModelWeightsBytes: 8 * GiB,
      gezelModelCacheBytes: 2 * GiB,
      engineReservedBytes: 10 * GiB,
      engineBudgetBytes: 38 * GiB,
      residentModels: [],
      gezelEngineProcessCount: 0,
      orphanedGezelEngineProcessCount: 0,
      otherBytes: 32 * GiB,
      cachedBytes: null,
      freeBytes: 20 * GiB,
      sampledAt: 'now',
      source: 'system-memory',
      deviceNames: [],
    });
  });

  it('prefers observed macOS process footprint over the capacity reservation', () => {
    const usage = sampleMachineMemoryUsage({
      profile: profile({
        platform: 'darwin',
        gpuVramBytes: null,
        source: 'darwin-unified',
      }),
      engineCommittedBytes: 10 * GiB,
      engineModelWeightsBytes: 8 * GiB,
      gezelProcessMemory: {
        bytes: 30 * GiB,
        engineProcessCount: 2,
        orphanedEngineProcessCount: 1,
      },
      serviceRssBytes: 2 * GiB,
      freeRamBytes: 20 * GiB,
      sampledAt: 'now',
    });

    expect(usage).toMatchObject({
      usedBytes: 44 * GiB,
      gezelBytesEstimated: 12 * GiB,
      gezelBytesObserved: 30 * GiB,
      gezelInfraBytes: 20 * GiB,
      gezelModelWeightsBytes: 8 * GiB,
      gezelModelCacheBytes: 2 * GiB,
      engineReservedBytes: 10 * GiB,
      gezelEngineProcessCount: 2,
      orphanedGezelEngineProcessCount: 1,
      otherBytes: 14 * GiB,
    });
  });

  it('keeps macOS file cache out of used and other memory', () => {
    const usage = sampleMachineMemoryUsage({
      profile: profile({
        platform: 'darwin',
        gpuVramBytes: null,
        source: 'darwin-unified',
      }),
      engineCommittedBytes: 10 * GiB,
      engineModelWeightsBytes: 8 * GiB,
      gezelProcessMemory: {
        bytes: 30 * GiB,
        engineProcessCount: 2,
        orphanedEngineProcessCount: 0,
      },
      darwinSystemMemory: {
        usedBytes: 40 * GiB,
        cachedBytes: 20 * GiB,
        freeBytes: 4 * GiB,
      },
      serviceRssBytes: 2 * GiB,
      sampledAt: 'now',
    });

    expect(usage).toMatchObject({
      totalBytes: 64 * GiB,
      usedBytes: 40 * GiB,
      gezelBytesObserved: 30 * GiB,
      otherBytes: 10 * GiB,
      cachedBytes: 20 * GiB,
      freeBytes: 4 * GiB,
    });
  });

  it('treats a non-Mac GPU pool close to total RAM as UMA', () => {
    const usage = sampleMachineMemoryUsage({
      profile: profile({
        gpuVramBytes: 60 * GiB,
        gpuMemoryKind: 'unified',
        source: 'gpu-vulkan',
      }),
      freeRamBytes: 24 * GiB,
      serviceRssBytes: 1 * GiB,
    });

    expect(usage.kind).toBe('unified');
    expect(usage.totalBytes).toBe(64 * GiB);
    expect(usage.usedBytes).toBe(40 * GiB);
  });

  it('uses VRAM telemetry for an explicitly discrete equal-sized GPU pool', () => {
    const usage = sampleMachineMemoryUsage({
      profile: profile({
        totalRamBytes: 16 * GiB,
        gpuVramBytes: 16 * GiB,
        gpuMemoryKind: 'discrete',
      }),
      deviceHealth: {
        state: 'healthy',
        mode: 'observe',
        sampledAt: 'driver-now',
        sources: ['nvidia-smi'],
        readings: [
          {
            vendor: 'nvidia',
            deviceId: '0',
            name: 'NVIDIA GeForce RTX 5060 Ti',
            memoryUsedMb: 4 * 1024,
            memoryTotalMb: 16 * 1024,
          },
        ],
        reasons: [],
        summary: 'healthy',
      },
    });

    expect(usage).toMatchObject({
      kind: 'vram',
      totalBytes: 16 * GiB,
      usedBytes: 4 * GiB,
      freeBytes: 12 * GiB,
      deviceNames: ['NVIDIA GeForce RTX 5060 Ti'],
    });
  });

  it('uses main RAM when CPU inference is selected despite a discrete GPU', () => {
    const usage = sampleMachineMemoryUsage({
      profile: profile(),
      forceMainMemory: true,
      freeRamBytes: 40 * GiB,
      serviceRssBytes: 1 * GiB,
    });

    expect(usage.kind).toBe('ram');
    expect(usage.totalBytes).toBe(64 * GiB);
    expect(usage.usedBytes).toBe(24 * GiB);
  });

  it('keeps capacity reservations separate when only aggregate driver VRAM is available', () => {
    const usage = sampleMachineMemoryUsage({
      profile: profile(),
      engineCommittedBytes: 5 * GiB,
      engineModelWeightsBytes: 4 * GiB,
      deviceHealth: {
        state: 'healthy',
        mode: 'observe',
        sampledAt: 'driver-now',
        sources: ['nvml'],
        readings: [
          {
            vendor: 'nvidia',
            deviceId: '0',
            name: 'Test GPU',
            memoryUsedMb: 9 * 1024,
            memoryTotalMb: 24 * 1024,
          },
        ],
        reasons: [],
        summary: 'healthy',
      },
    });

    expect(usage).toMatchObject({
      kind: 'vram',
      totalBytes: 24 * GiB,
      usedBytes: 9 * GiB,
      gezelBytesEstimated: 0,
      gezelBytesObserved: null,
      gezelInfraBytes: 0,
      gezelModelWeightsBytes: 0,
      gezelModelCacheBytes: 0,
      engineReservedBytes: 5 * GiB,
      otherBytes: 9 * GiB,
      freeBytes: 15 * GiB,
      source: 'device-health',
      deviceNames: ['Test GPU'],
    });
  });

  it('attributes Windows dedicated VRAM to actual Gezel engine processes', () => {
    const usage = sampleMachineMemoryUsage({
      profile: profile({ source: 'gpu-vulkan', gpuVendor: 'amd', gpuVramBytes: 32 * GiB }),
      engineCommittedBytes: 21 * GiB,
      deviceHealth: {
        state: 'healthy',
        mode: 'observe',
        sampledAt: 'driver-now',
        sources: ['amd-adl', 'windows-gpu-process-memory'],
        readings: [
          {
            vendor: 'amd',
            deviceId: '0',
            name: 'Radeon',
            memoryUsedMb: 30 * 1024,
            memoryTotalMb: 32 * 1024,
          },
        ],
        processes: [
          {
            pid: 101,
            name: 'gezel-llama-server.exe',
            dedicatedBytes: 13 * GiB,
            owner: 'machine-engine',
          },
          {
            pid: 202,
            name: 'gezel-llama-server.exe',
            dedicatedBytes: 13 * GiB,
            owner: 'development-engine',
          },
          {
            pid: 303,
            name: 'game.exe',
            dedicatedBytes: 3 * GiB,
            owner: 'external',
          },
        ],
        reasons: [],
        summary: 'healthy',
      },
    });

    expect(usage).toMatchObject({
      usedBytes: 30 * GiB,
      gezelBytesObserved: 26 * GiB,
      engineReservedBytes: 21 * GiB,
      otherBytes: 4 * GiB,
      gezelEngineProcessCount: 2,
    });
    expect(usage.gpuProcesses).toHaveLength(3);
  });

  it('attributes nothing to the pool when a driver exposes capacity but not use', () => {
    // Regression: the reservation used to be clamped into the card's own
    // capacity, so three resident models reserving more than the card holds
    // drew a full bar and claimed Gezel was using every byte of VRAM.
    const usage = sampleMachineMemoryUsage({
      profile: profile({ source: 'gpu-vulkan', gpuVendor: 'amd' }),
      engineCommittedBytes: 50 * GiB,
      engineBudgetBytes: 68 * GiB,
      engineModelWeightsBytes: 40 * GiB,
      residentModels: [
        {
          provider: 'llama-cpp',
          modelId: 'qwen3.6-35b-a3b-q4',
          reservedBytes: 25 * GiB,
          replicaCount: 1,
        },
        {
          provider: 'llama-cpp',
          modelId: 'qwen3.6-27b-q4',
          reservedBytes: 19 * GiB,
          replicaCount: 1,
        },
        {
          provider: 'llama-cpp',
          modelId: 'gemma4-e4b-q4',
          reservedBytes: 6 * GiB,
          replicaCount: 1,
        },
      ],
      deviceHealth: {
        state: 'healthy',
        mode: 'observe',
        sampledAt: 'driver-now',
        sources: ['amd-adl'],
        readings: [
          {
            vendor: 'amd',
            deviceId: '0',
            name: 'Radeon',
            memoryTotalMb: 16 * 1024,
          },
        ],
        reasons: [],
        summary: 'healthy',
      },
    });

    expect(usage).toMatchObject({
      totalBytes: 16 * GiB,
      usedBytes: null,
      gezelBytesEstimated: 0,
      gezelInfraBytes: 0,
      gezelModelWeightsBytes: 0,
      gezelModelCacheBytes: 0,
      engineReservedBytes: 50 * GiB,
      engineBudgetBytes: 68 * GiB,
      otherBytes: null,
      freeBytes: null,
    });
    expect(usage.residentModels).toHaveLength(3);
  });
});

describe('summarizeResidentModels', () => {
  it('collapses replicas of one model into a single heaviest-first row', () => {
    expect(
      summarizeResidentModels([
        { provider: 'llama-cpp', modelId: 'gemma4-e4b-q4', residentBytes: 6 * GiB },
        { provider: 'llama-cpp', modelId: 'qwen3.6-27b-q4', residentBytes: 19 * GiB },
        { provider: 'llama-cpp', modelId: 'gemma4-e4b-q4', residentBytes: 6 * GiB },
      ]),
    ).toEqual([
      {
        provider: 'llama-cpp',
        modelId: 'qwen3.6-27b-q4',
        reservedBytes: 19 * GiB,
        replicaCount: 1,
      },
      {
        provider: 'llama-cpp',
        modelId: 'gemma4-e4b-q4',
        reservedBytes: 12 * GiB,
        replicaCount: 2,
      },
    ]);
  });

  it('keeps the same model id under two engines apart', () => {
    const rows = summarizeResidentModels([
      { provider: 'llama-cpp', modelId: 'gemma4-e4b-q4', residentBytes: 6 * GiB },
      { provider: 'mlx', modelId: 'gemma4-e4b-q4', residentBytes: 7 * GiB },
    ]);
    expect(rows.map((row) => row.provider)).toEqual(['mlx', 'llama-cpp']);
  });
});
