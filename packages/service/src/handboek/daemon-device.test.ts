import { describe, expect, it } from 'vitest';
import { classifyHardwareTier, describeCurrentHardware } from './daemon-device.js';

describe('handboek hardware summary', () => {
  it('classifies the usable local-model budget at the onboarding boundaries', () => {
    expect(classifyHardwareTier(4_999_999_999)).toBe('tiny');
    expect(classifyHardwareTier(5_000_000_000)).toBe('small');
    expect(classifyHardwareTier(13_000_000_000)).toBe('medium');
    expect(classifyHardwareTier(25_000_000_000)).toBe('large');
  });

  it('describes unified-memory, discrete-GPU, and CPU-only devices', () => {
    const apple = describeCurrentHardware({
      totalRamBytes: 64_000_000_000,
      gpuVramBytes: null,
      usableBytes: 38_400_000_000,
      source: 'darwin-unified',
    });
    expect(apple).toEqual({
      description:
        'Apple Silicon unified memory: 64.0 GB total, with about 38.4 GB available for local models.',
      tier: 'large',
    });

    const gpu = describeCurrentHardware({
      totalRamBytes: 64_000_000_000,
      gpuVramBytes: 12_000_000_000,
      usableBytes: 11_400_000_000,
      source: 'gpu-nvidia',
      gpuVendor: 'nvidia',
    });
    expect(gpu.description).toContain('NVIDIA GPU: 12.0 GB VRAM');
    expect(gpu.tier).toBe('small');

    const cpu = describeCurrentHardware({
      totalRamBytes: 16_000_000_000,
      gpuVramBytes: null,
      usableBytes: 8_000_000_000,
      source: 'system-ram-fallback',
    });
    expect(cpu.description).toContain('No dedicated GPU detected');
    expect(cpu.tier).toBe('small');
  });
});
