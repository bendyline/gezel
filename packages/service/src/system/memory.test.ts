import { describe, expect, it } from 'vitest';
import type { MemoryProfile } from './memory.js';
import { sampleMachineMemoryUsage } from './memory.js';

const GiB = 1024 ** 3;

function profile(overrides: Partial<MemoryProfile> = {}): MemoryProfile {
  return {
    platform: 'linux',
    totalRamBytes: 64 * GiB,
    gpuVramBytes: 24 * GiB,
    source: 'gpu-nvidia',
    usableBytes: 22 * GiB,
    budgetBytes: 60 * GiB,
    gpuVendor: 'nvidia',
    ...overrides,
  };
}

describe('sampleMachineMemoryUsage', () => {
  it('uses main memory for Apple/UMA and attributes resident engines plus daemon RSS', () => {
    const usage = sampleMachineMemoryUsage({
      profile: profile({
        platform: 'darwin',
        gpuVramBytes: null,
        source: 'darwin-unified',
      }),
      engineCommittedBytes: 10 * GiB,
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
      gezelEngineProcessCount: 0,
      orphanedGezelEngineProcessCount: 0,
      otherBytes: 32 * GiB,
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

  it('treats a non-Mac GPU pool close to total RAM as UMA', () => {
    const usage = sampleMachineMemoryUsage({
      profile: profile({
        gpuVramBytes: 60 * GiB,
        source: 'gpu-vulkan',
      }),
      freeRamBytes: 24 * GiB,
      serviceRssBytes: 1 * GiB,
    });

    expect(usage.kind).toBe('unified');
    expect(usage.totalBytes).toBe(64 * GiB);
    expect(usage.usedBytes).toBe(40 * GiB);
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

  it('uses aggregate driver VRAM and subtracts estimated Gezel residency from other use', () => {
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
      gezelBytesEstimated: 5 * GiB,
      gezelBytesObserved: null,
      gezelInfraBytes: 0,
      gezelModelWeightsBytes: 4 * GiB,
      gezelModelCacheBytes: 1 * GiB,
      engineReservedBytes: 5 * GiB,
      otherBytes: 4 * GiB,
      freeBytes: 15 * GiB,
      source: 'device-health',
      deviceNames: ['Test GPU'],
    });
  });

  it('keeps other/free unknown when a driver exposes capacity but not use', () => {
    const usage = sampleMachineMemoryUsage({
      profile: profile({ source: 'gpu-vulkan', gpuVendor: 'amd' }),
      engineCommittedBytes: 4 * GiB,
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
      gezelBytesEstimated: 4 * GiB,
      otherBytes: null,
      freeBytes: null,
    });
  });
});
