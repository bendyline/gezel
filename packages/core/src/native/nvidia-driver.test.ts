import { describe, expect, it } from 'vitest';
import {
  compareDriverVersions,
  linuxCudaBuildBlocker,
  minimumNvidiaDriverForCuda,
  nvidiaCudaBlocker,
  nvidiaLibraryVersion,
  parseNvidiaModuleVersion,
} from './nvidia-driver.js';

const OPEN_MODULE =
  'NVRM version: NVIDIA UNIX Open Kernel Module for aarch64  580.173.02  Release Build  (dvs-builder@U22-A24-5-4)  Tue Jun 23 08:34:19 UTC 2026\nGCC version:  gcc version 13.3.0\n';
const PROPRIETARY_MODULE =
  'NVRM version: NVIDIA UNIX x86_64 Kernel Module  550.120  Fri Sep 13 10:10:01 UTC 2024\n';

describe('NVIDIA driver facts', () => {
  it('reads the loaded module version from the open and the proprietary module', () => {
    expect(parseNvidiaModuleVersion(OPEN_MODULE)).toBe('580.173.02');
    expect(parseNvidiaModuleVersion(PROPRIETARY_MODULE)).toBe('550.120');
    expect(parseNvidiaModuleVersion('something else')).toBeNull();
  });

  it('reads the library version from the file libcuda.so.1 resolves to', () => {
    expect(nvidiaLibraryVersion('/usr/lib/aarch64-linux-gnu/libcuda.so.580.173.02')).toBe(
      '580.173.02',
    );
    expect(nvidiaLibraryVersion('/usr/lib/x86_64-linux-gnu/libcuda.so.1')).toBeNull();
  });

  it('knows the oldest driver each CUDA major accepts', () => {
    expect(minimumNvidiaDriverForCuda('13.0')).toBe('580.65.06');
    expect(minimumNvidiaDriverForCuda('12.8')).toBe('525.60.13');
    expect(minimumNvidiaDriverForCuda('9.2')).toBeNull();
  });

  it('compares versions segment by segment, not as strings', () => {
    expect(compareDriverVersions('580.173.02', '580.65.06')).toBeGreaterThan(0);
    expect(compareDriverVersions('570.86', '580.65.06')).toBeLessThan(0);
    expect(compareDriverVersions('550.120', '550.120.0')).toBe(0);
  });
});

describe('nvidiaCudaBlocker', () => {
  it('lets a matching, new-enough driver run the build', () => {
    expect(
      nvidiaCudaBlocker({
        moduleVersion: '580.173.02',
        libraryVersion: '580.173.02',
        cudaToolkit: '13.0',
      }),
    ).toBeNull();
  });

  it('says a module that is not loaded rules CUDA out', () => {
    expect(
      nvidiaCudaBlocker({ moduleVersion: null, libraryVersion: '580.95.05', cudaToolkit: '13.0' }),
    ).toMatchObject({ kind: 'module-not-loaded', installed: '580.95.05' });
  });

  it('asks for a restart when the library moved past the loaded module', () => {
    expect(
      nvidiaCudaBlocker({
        moduleVersion: '570.86.10',
        libraryVersion: '580.95.05',
        cudaToolkit: '13.0',
      }),
    ).toMatchObject({ kind: 'restart-required', installed: '580.95.05', loaded: '570.86.10' });
  });

  it('asks for a newer driver than the build’s CUDA runtime accepts', () => {
    expect(
      nvidiaCudaBlocker({ moduleVersion: '570.86.10', libraryVersion: null, cudaToolkit: '13.0' }),
    ).toMatchObject({ kind: 'driver-too-old', installed: '570.86.10', required: '580.65.06' });
    // The x64 build ships CUDA 12, which that driver runs.
    expect(
      nvidiaCudaBlocker({ moduleVersion: '570.86.10', libraryVersion: null, cudaToolkit: '12.8' }),
    ).toBeNull();
  });

  it('rules nothing out over a toolkit it does not know', () => {
    expect(
      nvidiaCudaBlocker({
        moduleVersion: '470.1',
        libraryVersion: '470.1',
        cudaToolkit: undefined,
      }),
    ).toBeNull();
  });
});

describe('linuxCudaBuildBlocker', () => {
  const binary = '/opt/Gezel/native/linux-arm64-cuda/gezel-llama-server';
  const libcuda = '/usr/lib/aarch64-linux-gnu/libcuda.so.1';
  function host(files: Record<string, string>, links: Record<string, string> = {}) {
    const exists = new Set([...Object.keys(files), ...Object.keys(links)]);
    return {
      fileExists: (path: string) => exists.has(path),
      readFile: (path: string) => {
        const text = files[path];
        if (text === undefined) throw new Error(`ENOENT: ${path}`);
        return text;
      },
      realpath: (path: string) => links[path] ?? path,
    };
  }
  const build = {
    '/opt/Gezel/native/linux-arm64-cuda/gezel-llama-build.json': '{"cudaToolkit":"13.0"}',
  };

  it('finds the driver too old for the bundled CUDA 13 runtime', () => {
    const io = host(
      { ...build, '/proc/driver/nvidia/version': PROPRIETARY_MODULE },
      { [libcuda]: '/usr/lib/aarch64-linux-gnu/libcuda.so.550.120' },
    );
    expect(linuxCudaBuildBlocker(binary, io)).toMatchObject({
      kind: 'driver-too-old',
      cudaToolkit: '13.0',
    });
  });

  it('finds a module that is not loaded', () => {
    const io = host(build, { [libcuda]: '/usr/lib/aarch64-linux-gnu/libcuda.so.580.95.05' });
    expect(linuxCudaBuildBlocker(binary, io)?.kind).toBe('module-not-loaded');
  });

  it('says nothing without libcuda, under WSL, or for a module format it cannot read', () => {
    expect(linuxCudaBuildBlocker(binary, host(build))).toBeNull();
    const wsl = host({ ...build, '/dev/dxg': '' }, { [libcuda]: libcuda });
    expect(linuxCudaBuildBlocker(binary, wsl)).toBeNull();
    const odd = host(
      { ...build, '/proc/driver/nvidia/version': 'NVRM version: something new' },
      { [libcuda]: libcuda },
    );
    expect(linuxCudaBuildBlocker(binary, odd)).toBeNull();
  });
});
