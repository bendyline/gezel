import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  gpuMemoryKindFromName,
  gpuVendorFromName,
  llamaBinaryFingerprint,
  matchNvidiaRuntimeDevice,
  maxGpuVramBytes,
  parseLlamaDevices,
  parseNvidiaRuntimeDevices,
  pickBestGpuDevice,
  probeLlamaDevices,
} from '@bendyline/gezel-inference/internal/providers/llama-cpp/devices';
import { describe, expect, it } from 'vitest';

const M4_MAX = `Available devices:
  MTL0: Apple M4 Max (53084 MiB, 53083 MiB free)
  BLAS: Accelerate (0 MiB, 0 MiB free)`;

const RTX_4070 = `Available devices:
  CUDA0: NVIDIA GeForce RTX 4070 (12282 MiB, 11987 MiB free)`;

// The non-NVIDIA case this whole module wires up: a Radeon on the Vulkan
// backend, invisible to nvidia-smi.
const RADEON_VULKAN = `Available devices:
  Vulkan0: AMD Radeon RX 7900 XTX (24560 MiB, 24000 MiB free)`;

describe('parseLlamaDevices', () => {
  it('parses the Metal (unified memory) listing', () => {
    const d = parseLlamaDevices(M4_MAX);
    expect(d).toHaveLength(2);
    expect(d[0]).toEqual({ id: 'MTL0', name: 'Apple M4 Max', totalMiB: 53084, freeMiB: 53083 });
    expect(d[1]).toEqual({ id: 'BLAS', name: 'Accelerate', totalMiB: 0, freeMiB: 0 });
  });

  it('parses a discrete-GPU (CUDA) listing', () => {
    const d = parseLlamaDevices(RTX_4070);
    expect(d).toEqual([
      { id: 'CUDA0', name: 'NVIDIA GeForce RTX 4070', totalMiB: 12282, freeMiB: 11987 },
    ]);
  });

  it('ignores the header, blank lines, and log noise', () => {
    const noisy = `load_backend: loaded CUDA backend
Available devices:

  CUDA0: NVIDIA GeForce RTX 4070 (12282 MiB, 11987 MiB free)
some trailing garbage`;
    expect(parseLlamaDevices(noisy)).toHaveLength(1);
  });
});

describe('maxGpuVramBytes', () => {
  it('excludes the 0-MiB CPU/BLAS pseudo-device and returns bytes', () => {
    expect(maxGpuVramBytes(parseLlamaDevices(M4_MAX))).toBe(53084 * 1024 * 1024);
  });

  it('picks the largest GPU pool', () => {
    const d = parseLlamaDevices(
      '  CUDA0: A (8000 MiB, 8000 MiB free)\n  CUDA1: B (24000 MiB, 24000 MiB free)',
    );
    expect(maxGpuVramBytes(d)).toBe(24000 * 1024 * 1024);
  });

  it('returns 0 when there is no device', () => {
    expect(maxGpuVramBytes([])).toBe(0);
  });
});

describe('parseNvidiaRuntimeDevices', () => {
  it('captures GPU name, compute capability, and driver version', () => {
    expect(parseNvidiaRuntimeDevices('0, NVIDIA GB10, 12.1, 580.159.03\n')).toEqual([
      {
        index: 0,
        name: 'NVIDIA GB10',
        computeCapability: '12.1',
        driverVersion: '580.159.03',
      },
    ]);
  });

  it('ignores malformed nvidia-smi rows', () => {
    expect(parseNvidiaRuntimeDevices('not supported\n0, missing, fields\n')).toEqual([]);
  });

  it('matches the selected llama CUDA index on a multi-GPU host', () => {
    const nvidiaDevices = parseNvidiaRuntimeDevices(
      ['0, NVIDIA RTX 4090, 8.9, 580.65', '1, NVIDIA GB10, 12.1, 580.65'].join('\n'),
    );
    expect(
      matchNvidiaRuntimeDevice(
        { id: 'CUDA1', name: 'NVIDIA GB10', totalMiB: 119_000, freeMiB: 118_000 },
        nvidiaDevices,
      ),
    ).toMatchObject({ index: 1, computeCapability: '12.1' });
  });
});

describe('pickBestGpuDevice', () => {
  it('picks a non-NVIDIA (Vulkan/AMD) card — the case nvidia-smi is blind to', () => {
    const best = pickBestGpuDevice(parseLlamaDevices(RADEON_VULKAN));
    expect(best).toEqual({
      id: 'Vulkan0',
      name: 'AMD Radeon RX 7900 XTX',
      totalMiB: 24560,
      freeMiB: 24000,
    });
  });

  it('excludes the 0-MiB CPU/BLAS pseudo-device', () => {
    const best = pickBestGpuDevice(parseLlamaDevices(M4_MAX));
    expect(best?.id).toBe('MTL0');
  });

  it('picks the largest of several GPUs', () => {
    const d = parseLlamaDevices(
      '  CUDA0: A (8000 MiB, 8000 MiB free)\n  CUDA1: B (24000 MiB, 24000 MiB free)',
    );
    expect(pickBestGpuDevice(d)?.id).toBe('CUDA1');
  });

  it('prefers a real discrete card over a larger integrated shared allocation', () => {
    const d = parseLlamaDevices(
      [
        '  Vulkan0: Intel(R) Graphics (16000 MiB, 12000 MiB free)',
        '  Vulkan1: AMD Radeon RX 7800 XT (12288 MiB, 12000 MiB free)',
      ].join('\n'),
    );
    expect(pickBestGpuDevice(d)?.name).toBe('AMD Radeon RX 7800 XT');
  });

  it('returns null when there is no GPU (empty or all-zero)', () => {
    expect(pickBestGpuDevice([])).toBeNull();
    expect(
      pickBestGpuDevice(parseLlamaDevices('  BLAS: Accelerate (0 MiB, 0 MiB free)')),
    ).toBeNull();
  });
});

describe('gpuVendorFromName', () => {
  it('reads the vendor off the real --list-devices name (never hardcoded)', () => {
    expect(gpuVendorFromName('AMD Radeon AI PRO R9700')).toBe('amd');
    expect(gpuVendorFromName('NVIDIA GeForce RTX 4070')).toBe('nvidia');
    expect(gpuVendorFromName('Intel(R) Arc(TM) A770 Graphics')).toBe('intel');
  });

  it('does NOT mislabel an Intel GPU as AMD (the reported concern)', () => {
    // A generic Vulkan listing for an Intel card must read Intel, not AMD.
    expect(gpuVendorFromName('Intel(R) UHD Graphics')).toBe('intel');
    expect(gpuVendorFromName('Intel(R) Arc(TM) A770 Graphics')).not.toBe('amd');
  });

  it('returns undefined for software / unrecognized devices (caller shows generic "GPU")', () => {
    expect(gpuVendorFromName('llvmpipe (LLVM 15.0.7, 256 bits)')).toBeUndefined();
    expect(gpuVendorFromName('SwiftShader Device')).toBeUndefined();
  });
});

describe('gpuMemoryKindFromName', () => {
  it('classifies Surface-class Intel graphics as integrated shared memory', () => {
    expect(gpuMemoryKindFromName('Intel(R) UHD Graphics')).toBe('integrated');
    expect(gpuMemoryKindFromName('Intel(R) Iris(R) Xe Graphics')).toBe('integrated');
    expect(gpuMemoryKindFromName('Intel(R) Graphics')).toBe('integrated');
    expect(gpuMemoryKindFromName('Intel(R) Arc(TM) Graphics')).toBe('integrated');
  });

  it('keeps discrete Intel Arc boards discrete', () => {
    expect(gpuMemoryKindFromName('Intel(R) Arc(TM) A770 Graphics')).toBe('discrete');
    expect(gpuMemoryKindFromName('Intel Arc B580 Graphics')).toBe('discrete');
    expect(gpuMemoryKindFromName('Intel Arc Pro A60 Graphics')).toBe('discrete');
  });

  it('recognizes common integrated and discrete AMD/Qualcomm families', () => {
    expect(gpuMemoryKindFromName('AMD Radeon 780M Graphics')).toBe('integrated');
    expect(gpuMemoryKindFromName('AMD Radeon Graphics')).toBe('integrated');
    expect(gpuMemoryKindFromName('Qualcomm Adreno X1-85 GPU')).toBe('integrated');
    expect(gpuMemoryKindFromName('AMD Radeon RX 7900 XTX')).toBe('discrete');
    expect(gpuMemoryKindFromName('AMD Radeon AI PRO R9700')).toBe('discrete');
  });

  it('does not guess for an unrecognized Vulkan device', () => {
    expect(gpuMemoryKindFromName('Some Future Accelerator')).toBe('unknown');
  });
});

describe('probeLlamaDevices cache', () => {
  const GiB = 1024 ** 3;
  const igpu = { id: 'Vulkan0', name: 'AMD Radeon(TM) Graphics', totalMiB: 3072, freeMiB: 3000 };
  const probedAt = '2026-10-19T13:03:22.545Z';

  // A binary that cannot run makes a fresh probe come back empty, which
  // tells the two paths apart without spawning anything real.
  const binaryIn = (home: string) => join(home, 'llama-server');

  async function homeWithCache(
    systemRamBytes?: number,
    opts: { devices?: unknown[]; binary?: 'match' | 'none' } = {},
  ): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), 'gezel-devices-'));
    await mkdir(join(home, 'engines', 'llama-cpp'), { recursive: true });
    await writeFile(binaryIn(home), 'not an executable');
    await writeFile(
      join(home, 'engines', 'llama-cpp', 'devices.json'),
      JSON.stringify({
        devices: opts.devices ?? [igpu],
        probedAt,
        cached: false,
        systemRamBytes,
        ...(opts.binary === 'none' ? {} : { binary: llamaBinaryFingerprint(binaryIn(home)) }),
      }),
    );
    return home;
  }

  const probe = (home: string, systemRamBytes: number, nowIso = probedAt) =>
    probeLlamaDevices({ binaryPath: binaryIn(home), home, systemRamBytes, nowIso: () => nowIso });

  it('serves the cache while the OS reports the RAM it was probed with', async () => {
    const home = await homeWithCache(13 * GiB);
    try {
      expect(await probe(home, 13 * GiB)).toMatchObject({ cached: true, devices: [igpu] });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('re-probes after a carve-out change moved RAM between the OS and the GPU', async () => {
    const home = await homeWithCache(13 * GiB);
    try {
      expect(await probe(home, 8 * GiB)).toMatchObject({ cached: false, devices: [] });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('re-probes a cache written before the RAM figure was recorded', async () => {
    const home = await homeWithCache();
    try {
      expect((await probe(home, 13 * GiB)).cached).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('re-probes a cache written before the binary was recorded', async () => {
    const home = await homeWithCache(13 * GiB, { binary: 'none' });
    try {
      expect((await probe(home, 13 * GiB)).cached).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('re-probes when a native update replaced the build that answered', async () => {
    const home = await homeWithCache(13 * GiB);
    try {
      await writeFile(binaryIn(home), 'a newer build, a different size');
      expect((await probe(home, 13 * GiB)).cached).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('serves an empty listing briefly, then asks again', async () => {
    const home = await homeWithCache(13 * GiB, { devices: [] });
    try {
      expect((await probe(home, 13 * GiB, '2026-10-19T13:30:00.000Z')).cached).toBe(true);
      expect((await probe(home, 13 * GiB, '2026-10-19T14:30:00.000Z')).cached).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
