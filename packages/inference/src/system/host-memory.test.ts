import { describe, expect, it } from 'vitest';
import {
  type HostLimitsProbe,
  availableCpuCount,
  capToContainer,
  containerCpuLimit,
  containerMemoryLimitBytes,
  freeMemoryBytes,
  totalMemoryBytes,
} from './host-memory.js';

const GIB = 1024 ** 3;

function probe(overrides: Partial<HostLimitsProbe> = {}): HostLimitsProbe {
  return {
    totalmem: () => 64 * GIB,
    freemem: () => 40 * GIB,
    constrainedMemory: () => undefined,
    availableMemory: () => undefined,
    availableParallelism: () => 16,
    hostCpuCount: () => 16,
    readFile: () => undefined,
    ...overrides,
  };
}

describe('host memory', () => {
  it('reports the host when there is no container limit', () => {
    for (const constrained of [undefined, 0, 64 * GIB, 2 ** 64]) {
      const p = probe({ constrainedMemory: () => constrained });
      expect(containerMemoryLimitBytes(p)).toBeNull();
      expect(totalMemoryBytes(p)).toBe(64 * GIB);
      expect(freeMemoryBytes(p)).toBe(40 * GIB);
    }
  });

  it('reports the container limit, and what it leaves free', () => {
    const p = probe({ constrainedMemory: () => 8 * GIB, availableMemory: () => 5 * GIB });
    expect(totalMemoryBytes(p)).toBe(8 * GIB);
    expect(freeMemoryBytes(p)).toBe(5 * GIB);
    // A host-wide MemAvailable reading is capped the same way.
    expect(capToContainer(30 * GIB, p)).toBe(5 * GIB);
    expect(capToContainer(3 * GIB, p)).toBe(3 * GIB);
  });
});

describe('availableCpuCount', () => {
  it('uses the CPU set when there is no quota', () => {
    expect(availableCpuCount(probe())).toBe(16);
    expect(
      availableCpuCount(
        probe({ readFile: (p) => (p.endsWith('cpu.max') ? 'max 100000' : undefined) }),
      ),
    ).toBe(16);
  });

  it('rounds a cgroup v2 quota up', () => {
    const files: Record<string, string> = { '/sys/fs/cgroup/cpu.max': '250000 100000' };
    expect(availableCpuCount(probe({ readFile: (p) => files[p] }))).toBe(3);
  });

  it('reads a cgroup v1 quota', () => {
    const files: Record<string, string> = {
      '/sys/fs/cgroup/cpu/cpu.cfs_quota_us': '400000',
      '/sys/fs/cgroup/cpu/cpu.cfs_period_us': '100000',
    };
    expect(availableCpuCount(probe({ readFile: (p) => files[p] }))).toBe(4);
  });

  it('never exceeds the CPU set', () => {
    const files: Record<string, string> = { '/sys/fs/cgroup/cpu.max': '3200000 100000' };
    expect(availableCpuCount(probe({ readFile: (p) => files[p] }))).toBe(16);
  });
});

describe('containerCpuLimit', () => {
  it('is null on an unconstrained host', () => {
    expect(containerCpuLimit(probe())).toBeNull();
  });

  it('reports a quota or a CPU set below the host', () => {
    const files: Record<string, string> = { '/sys/fs/cgroup/cpu.max': '400000 100000' };
    expect(containerCpuLimit(probe({ readFile: (p) => files[p] }))).toBe(4);
    expect(containerCpuLimit(probe({ availableParallelism: () => 6 }))).toBe(6);
  });
});
