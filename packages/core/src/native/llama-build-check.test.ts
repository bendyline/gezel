import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveAvailableLlamaBinary } from './llama-backend.js';
import {
  LLAMA_CUDA_BLOCKER_ENV,
  createLlamaBuildCheck,
  publishLlamaCudaBlocker,
  readLlamaCudaBlocker,
} from './llama-build-check.js';
import { type LlamaQuarantineEntry, binaryFingerprint } from './llama-quarantine.js';
import type { NvidiaCudaBlocker } from './nvidia-driver.js';

const paths: Record<string, string> = {
  cuda: '/n/linux-x64-cuda/gezel-llama-server',
  vulkan: '/n/linux-x64-vulkan/gezel-llama-server',
  cpu: '/n/linux-x64-cpu/gezel-llama-server',
};
const tooOld: NvidiaCudaBlocker = {
  kind: 'driver-too-old',
  installed: '570.86.10',
  required: '580.65.06',
  cudaToolkit: '13.0',
  detail: 'NVIDIA driver 570.86.10 is older than 580.65.06',
};

describe('createLlamaBuildCheck', () => {
  it('passes a Linux CUDA build the driver cannot run for the next one down', () => {
    const check = createLlamaBuildCheck({
      quarantine: [],
      platform: 'linux',
      cudaBlockerFor: () => tooOld,
    });
    const resolved = resolveAvailableLlamaBinary(
      'cuda',
      (backend) => paths[backend] ?? null,
      true,
      check.isUsable,
    );
    expect(resolved).toMatchObject({ backend: 'vulkan', skippedUnusable: ['cuda'] });
    expect(check.cudaBlocker()).toEqual(tooOld);
    // A driver skip is not a quarantine: nothing to lift in Settings.
    expect(check.quarantinedOf(resolved?.skippedUnusable ?? [])).toEqual([]);
  });

  it('keeps the CUDA build when the driver can run it, and never asks off Linux', () => {
    const asked: string[] = [];
    const blockerFor = (path: string) => {
      asked.push(path);
      return null;
    };
    const linux = createLlamaBuildCheck({
      quarantine: [],
      platform: 'linux',
      cudaBlockerFor: blockerFor,
    });
    expect(linux.isUsable('cuda', paths.cuda as string)).toBe(true);
    const windows = createLlamaBuildCheck({
      quarantine: [],
      platform: 'win32',
      cudaBlockerFor: blockerFor,
    });
    expect(windows.isUsable('cuda', 'C:/n/win32-x64-cuda/gezel-llama-server.exe')).toBe(true);
    expect(asked).toEqual([paths.cuda]);
  });

  it('reports a quarantined build as quarantined, without asking the driver', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gezel-build-check-'));
    try {
      const binary = join(dir, 'gezel-llama-server');
      await writeFile(binary, 'cuda build');
      const entry: LlamaQuarantineEntry = {
        backend: 'cuda',
        fingerprint: binaryFingerprint(binary) ?? '',
        signal: 'SIGSEGV',
        reason: 'r',
        at: 'x',
      };
      let asked = false;
      const check = createLlamaBuildCheck({
        quarantine: [entry],
        platform: 'linux',
        cudaBlockerFor: () => {
          asked = true;
          return tooOld;
        },
      });
      expect(check.isUsable('cuda', binary)).toBe(false);
      expect(check.quarantinedOf(['cuda'])).toEqual(['cuda']);
      expect(asked).toBe(false);
      expect(check.cudaBlocker()).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('passes a ROCm build with no code for this GPU over for Vulkan', () => {
    const rocmPaths: Record<string, string> = {
      rocm: '/n/linux-x64-rocm/gezel-llama-server',
      vulkan: '/n/linux-x64-vulkan/gezel-llama-server',
      cpu: '/n/linux-x64-cpu/gezel-llama-server',
    };
    const asked: string[] = [];
    const check = createLlamaBuildCheck({
      quarantine: [],
      platform: 'linux',
      rocmCheckFor: (path) => {
        asked.push(path);
        return {
          blocker: { kind: 'no-supported-gpu', detail: 'gfx1030 is not built' },
          devices: [{ index: 0, name: 'Radeon RX 6800', gfx: 'gfx1030' }],
          visibleDevices: null,
        };
      },
    });
    const resolved = resolveAvailableLlamaBinary(
      'rocm',
      (backend) => rocmPaths[backend] ?? null,
      true,
      check.isUsable,
    );
    expect(resolved).toMatchObject({ backend: 'vulkan', skippedUnusable: ['rocm'] });
    expect(asked).toEqual([rocmPaths.rocm]);
    expect(check.rocmCheck()?.blocker?.kind).toBe('no-supported-gpu');
    expect(check.quarantinedOf(resolved?.skippedUnusable ?? [])).toEqual([]);
  });

  it('keeps a ROCm build that found a GPU it supports, and never vetoes without a checker', () => {
    const supported = createLlamaBuildCheck({
      quarantine: [],
      platform: 'win32',
      rocmCheckFor: () => ({
        blocker: null,
        devices: [
          { index: 0, name: 'AMD Radeon(TM) Graphics', gfx: 'gfx1036' },
          { index: 1, name: 'AMD Radeon AI PRO R9700', gfx: 'gfx1201' },
        ],
        visibleDevices: [1],
      }),
    });
    expect(supported.isUsable('rocm', 'C:/n/win32-x64-rocm/gezel-llama-server.exe')).toBe(true);
    expect(supported.rocmCheck()?.visibleDevices).toEqual([1]);
    const unchecked = createLlamaBuildCheck({ quarantine: [], platform: 'win32' });
    expect(unchecked.isUsable('rocm', 'C:/n/win32-x64-rocm/gezel-llama-server.exe')).toBe(true);
    expect(unchecked.rocmCheck()).toBeNull();
  });
});

describe('the CUDA blocker env', () => {
  it('round-trips through the env and clears', () => {
    const env: NodeJS.ProcessEnv = {};
    publishLlamaCudaBlocker(tooOld, env);
    expect(readLlamaCudaBlocker(env)).toEqual(tooOld);
    publishLlamaCudaBlocker(null, env);
    expect(env[LLAMA_CUDA_BLOCKER_ENV]).toBeUndefined();
    expect(readLlamaCudaBlocker(env)).toBeNull();
  });

  it('ignores a value it cannot read', () => {
    expect(readLlamaCudaBlocker({ [LLAMA_CUDA_BLOCKER_ENV]: 'not json' })).toBeNull();
    expect(
      readLlamaCudaBlocker({ [LLAMA_CUDA_BLOCKER_ENV]: '{"kind":"other","detail":"x"}' }),
    ).toBeNull();
  });
});
