import { describe, expect, it } from 'vitest';
import {
  gpuVendorFromName,
  maxGpuVramBytes,
  parseLlamaDevices,
  pickBestGpuDevice,
} from './devices.js';

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
