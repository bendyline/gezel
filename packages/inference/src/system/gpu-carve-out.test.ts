import { describe, expect, it } from 'vitest';
import {
  gpuCarveOutBytes,
  gpuVendorFromPciId,
  linuxGpuAddressableBytes,
  linuxGpuCarveOutBytes,
  matchGpuAdapter,
} from './gpu-carve-out.js';

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

describe('gpuCarveOutBytes', () => {
  it('finds an AMD frame buffer the OS no longer counts', () => {
    // 16 GiB laptop, 8 GiB set aside for the GPU, ~200 MiB other firmware reservations.
    const visible = 16 * GiB - 8 * GiB - 200 * MiB;
    expect(
      gpuCarveOutBytes({
        installedRamBytes: 16 * GiB,
        visibleRamBytes: visible,
        deviceBytes: 8 * GiB,
      }),
    ).toBe(8 * GiB);
  });

  it('ignores a shared view that is far larger than the missing memory', () => {
    // Intel-style: the GPU reports half of RAM, but only firmware reservations are missing.
    expect(
      gpuCarveOutBytes({
        installedRamBytes: 32 * GiB,
        visibleRamBytes: 32 * GiB - 300 * MiB,
        deviceBytes: 16 * GiB,
      }),
    ).toBeNull();
  });

  it('answers null whenever it cannot tell', () => {
    const base = { visibleRamBytes: 8 * GiB, deviceBytes: 8 * GiB };
    expect(gpuCarveOutBytes({ ...base, installedRamBytes: null })).toBeNull();
    expect(gpuCarveOutBytes({ ...base, installedRamBytes: 8 * GiB })).toBeNull();
    expect(gpuCarveOutBytes({ ...base, installedRamBytes: 16 * GiB, deviceBytes: 0 })).toBeNull();
  });

  it('allows rounding between the three figures, never more than is missing', () => {
    const visible = 13 * GiB;
    expect(
      gpuCarveOutBytes({
        installedRamBytes: 16 * GiB,
        visibleRamBytes: visible,
        deviceBytes: 3 * GiB + 32 * MiB,
      }),
    ).toBe(3 * GiB);
  });
});

describe("gpuCarveOutBytes with Windows' adapter figure", () => {
  const visible = 16 * GiB - 8 * GiB - 200 * MiB;

  it('takes the adapter figure when it fits the missing memory', () => {
    expect(
      gpuCarveOutBytes({
        installedRamBytes: 16 * GiB,
        visibleRamBytes: visible,
        // A stale Vulkan figure from before the setting changed no longer matters.
        deviceBytes: 3 * GiB,
        adapterDedicatedBytes: 8 * GiB,
      }),
    ).toBe(8 * GiB);
  });

  it('trusts Windows alone when installed RAM is unknown', () => {
    expect(
      gpuCarveOutBytes({
        installedRamBytes: null,
        visibleRamBytes: visible,
        deviceBytes: 8 * GiB,
        adapterDedicatedBytes: 8 * GiB,
      }),
    ).toBe(8 * GiB);
  });

  it('refuses an adapter figure the missing memory cannot hold', () => {
    expect(
      gpuCarveOutBytes({
        installedRamBytes: 32 * GiB,
        visibleRamBytes: 32 * GiB - 300 * MiB,
        deviceBytes: 16 * GiB,
        adapterDedicatedBytes: 16 * GiB,
      }),
    ).toBeNull();
    expect(
      gpuCarveOutBytes({
        installedRamBytes: 16 * GiB,
        visibleRamBytes: visible,
        deviceBytes: 8 * GiB,
        adapterDedicatedBytes: 0,
      }),
    ).toBeNull();
  });
});

describe('linuxGpuCarveOutBytes', () => {
  const amd = (dedicatedBytes: number) => ({ vendorId: 0x1002, dedicatedBytes });
  // A 128 GiB Strix Halo with 96 GiB set aside for the GPU. The kernel sees
  // ~31 GiB; Vulkan reports the carve-out plus a GTT of half of that.
  const visible = 128 * GiB - 96 * GiB - 500 * MiB;
  const vulkan = 96 * GiB + Math.floor(visible / 2);

  it("takes amdgpu's VRAM figure for the only AMD GPU", () => {
    expect(
      linuxGpuCarveOutBytes({
        adapters: [amd(96 * GiB)],
        visibleRamBytes: visible,
        deviceBytes: vulkan,
      }),
    ).toBe(96 * GiB);
  });

  it('gives up when it cannot tell which AMD GPU is the integrated one', () => {
    expect(
      linuxGpuCarveOutBytes({
        adapters: [amd(512 * MiB), amd(16 * GiB)],
        visibleRamBytes: visible,
        deviceBytes: vulkan,
      }),
    ).toBeNull();
    expect(
      linuxGpuCarveOutBytes({ adapters: [], visibleRamBytes: visible, deviceBytes: vulkan }),
    ).toBeNull();
  });

  it('refuses a carve-out larger than everything Vulkan reports, or none at all', () => {
    expect(
      linuxGpuCarveOutBytes({
        adapters: [amd(96 * GiB)],
        visibleRamBytes: visible,
        deviceBytes: 16 * GiB,
      }),
    ).toBeNull();
    expect(
      linuxGpuCarveOutBytes({ adapters: [amd(0)], visibleRamBytes: visible, deviceBytes: vulkan }),
    ).toBeNull();
  });

  it('adds GTT to the carve-out for what the GPU can reach', () => {
    expect(
      linuxGpuAddressableBytes([
        { vendorId: 0x1002, dedicatedBytes: 2 * GiB, sharedSystemBytes: 15 * GiB },
      ]),
    ).toBe(17 * GiB);
    // Without GTT, or with two AMD GPUs, there is nothing to say.
    expect(linuxGpuAddressableBytes([amd(2 * GiB)])).toBeNull();
    expect(
      linuxGpuAddressableBytes([
        { vendorId: 0x1002, dedicatedBytes: 2 * GiB, sharedSystemBytes: 15 * GiB },
        { vendorId: 0x1002, dedicatedBytes: 16 * GiB, sharedSystemBytes: 15 * GiB },
      ]),
    ).toBeNull();
  });

  it('ignores other vendors', () => {
    expect(
      linuxGpuCarveOutBytes({
        adapters: [{ vendorId: 0x8086, dedicatedBytes: 8 * GiB }],
        visibleRamBytes: visible,
        deviceBytes: vulkan,
      }),
    ).toBeNull();
  });
});

describe('matchGpuAdapter', () => {
  const igpu = { name: 'AMD Radeon(TM) Graphics', vendorId: 0x1002, integrated: true };
  const card = { name: 'NVIDIA GeForce RTX 4060 Laptop GPU', vendorId: 0x10de, integrated: false };

  it('matches the Vulkan device to the adapter of the same name', () => {
    expect(matchGpuAdapter([card, igpu], 'AMD Radeon(TM) Graphics')).toBe(igpu);
    expect(matchGpuAdapter([card, igpu], 'amd radeon graphics')).toBe(igpu);
  });

  it('falls back to the only adapter, and gives up when it cannot tell', () => {
    expect(matchGpuAdapter([igpu], 'AMD Radeon 780M Graphics')).toBe(igpu);
    expect(matchGpuAdapter([card, igpu], 'Some Other GPU')).toBeNull();
    expect(matchGpuAdapter([], 'AMD Radeon(TM) Graphics')).toBeNull();
  });
});

describe('gpuVendorFromPciId', () => {
  it('names the three vendors the UI labels', () => {
    expect(gpuVendorFromPciId(0x1002)).toBe('amd');
    expect(gpuVendorFromPciId(0x8086)).toBe('intel');
    expect(gpuVendorFromPciId(0x10de)).toBe('nvidia');
    expect(gpuVendorFromPciId(0x5143)).toBeUndefined();
  });
});
