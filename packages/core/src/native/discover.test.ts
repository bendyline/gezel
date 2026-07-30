import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverNativeBinaries } from './discover.js';

let home: string;
let nativeBinDir: string;

const ENGINE_ENV_VARS = [
  'GEZEL_LLAMA_SERVER_BIN',
  'GEZEL_LLAMA_SERVER_BACKEND',
  'GEZEL_LLAMA_DETECTED_BACKEND',
  'GEZEL_LLAMA_DETECTED_VENDOR',
  'GEZEL_DS4_SERVER_BIN',
  'GEZEL_SD_SERVER_BIN',
  'GEZEL_WHISPER_SERVER_BIN',
  'GEZEL_DEVICE_HEALTH_BIN',
  'GEZEL_UV_BIN',
  'GEZEL_NATIVE_BIN_DIR',
] as const;

function clearEnv() {
  for (const v of ENGINE_ENV_VARS) delete process.env[v];
}

/** Stage a fake binary file under `<root>/<subdir>/<name>[.exe]`. */
function stageBinary(
  root: string,
  subdir: string,
  name: string,
  platform: NodeJS.Platform,
): string {
  const ext = platform === 'win32' ? '.exe' : '';
  const dir = join(root, subdir);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}${ext}`);
  writeFileSync(path, '');
  return path;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gezel-discover-home-'));
  nativeBinDir = mkdtempSync(join(tmpdir(), 'gezel-discover-bin-'));
  clearEnv();
});
afterEach(() => {
  clearEnv();
  rmSync(home, { recursive: true, force: true });
  rmSync(nativeBinDir, { recursive: true, force: true });
});

describe('discoverNativeBinaries — Windows + NVIDIA (system service case)', () => {
  it('probes CUDA, resolves the cuda llama-server, and stamps env vars', () => {
    const llamaBin = stageBinary(nativeBinDir, 'win32-x64-cuda', 'llama-server', 'win32');
    const sdBin = stageBinary(nativeBinDir, 'win32-x64', 'sd-server', 'win32');
    const healthBin = stageBinary(nativeBinDir, 'win32-x64', 'gezel-device-health', 'win32');
    const uvBin = stageBinary(nativeBinDir, 'win32-x64', 'uv', 'win32');

    const result = discoverNativeBinaries({
      home,
      nativeBinDirOverride: nativeBinDir,
      platform: 'win32',
      arch: 'x64',
      llamaProbeOverride: {
        fileExists: (p) => p.endsWith('nvcuda.dll'),
      },
    });

    expect(process.env.GEZEL_LLAMA_SERVER_BIN).toBe(llamaBin);
    expect(process.env.GEZEL_LLAMA_SERVER_BACKEND).toBe('cuda');
    expect(process.env.GEZEL_LLAMA_DETECTED_BACKEND).toBe('cuda');
    expect(process.env.GEZEL_LLAMA_DETECTED_VENDOR).toBe('nvidia');
    expect(process.env.GEZEL_SD_SERVER_BIN).toBe(sdBin);
    expect(process.env.GEZEL_DEVICE_HEALTH_BIN).toBe(healthBin);
    expect(process.env.GEZEL_UV_BIN).toBe(uvBin);
    expect(process.env.GEZEL_WHISPER_SERVER_BIN).toBeUndefined();
    expect(result.llamaBackend?.backend).toBe('cuda');
    expect(result.binaries.find((b) => b.name === 'llama-server')?.source).toBe('discovered');
    expect(result.binaries.find((b) => b.name === 'whisper-server')?.source).toBe('not-found');
  });
});

describe('discoverNativeBinaries — gezel- prefixed binaries (post-rename)', () => {
  it('discovers the gezel- prefixed binary that current build scripts emit', () => {
    const sdBin = stageBinary(nativeBinDir, 'linux-x64', 'gezel-sd-server', 'linux');
    const whisperBin = stageBinary(nativeBinDir, 'linux-x64', 'gezel-whisper-server', 'linux');
    const uvBin = stageBinary(nativeBinDir, 'linux-x64', 'uv', 'linux'); // uv stays unprefixed

    const result = discoverNativeBinaries({
      home,
      nativeBinDirOverride: nativeBinDir,
      platform: 'linux',
      arch: 'x64',
      llamaProbeOverride: { fileExists: () => false }, // no GPU → cpu, deterministic
    });

    expect(process.env.GEZEL_SD_SERVER_BIN).toBe(sdBin);
    expect(process.env.GEZEL_WHISPER_SERVER_BIN).toBe(whisperBin);
    expect(process.env.GEZEL_UV_BIN).toBe(uvBin);
    expect(result.binaries.find((b) => b.name === 'sd-server')?.source).toBe('discovered');
  });

  it('prefers the gezel- name over a stale legacy bare-named binary', () => {
    // A box that fetched a post-rename release next to a leftover pre-rename
    // build: the gezel- prefixed binary must win the resolution.
    stageBinary(nativeBinDir, 'linux-x64', 'sd-server', 'linux'); // legacy
    const gezelBin = stageBinary(nativeBinDir, 'linux-x64', 'gezel-sd-server', 'linux');

    discoverNativeBinaries({
      home,
      nativeBinDirOverride: nativeBinDir,
      platform: 'linux',
      arch: 'x64',
      llamaProbeOverride: { fileExists: () => false },
    });

    expect(process.env.GEZEL_SD_SERVER_BIN).toBe(gezelBin);
  });
});

describe('discoverNativeBinaries — short-circuits', () => {
  it('is a no-op when env vars are already set by the supervisor', () => {
    process.env.GEZEL_LLAMA_SERVER_BIN = '/already/set/llama-server';
    process.env.GEZEL_DS4_SERVER_BIN = '/already/set/ds4-server';
    process.env.GEZEL_SD_SERVER_BIN = '/already/set/sd-server';
    process.env.GEZEL_WHISPER_SERVER_BIN = '/already/set/whisper-server';
    process.env.GEZEL_DEVICE_HEALTH_BIN = '/already/set/gezel-device-health';
    process.env.GEZEL_UV_BIN = '/already/set/uv';

    const result = discoverNativeBinaries({
      home,
      nativeBinDirOverride: nativeBinDir,
      platform: 'linux',
      arch: 'x64',
    });

    expect(process.env.GEZEL_LLAMA_SERVER_BIN).toBe('/already/set/llama-server');
    expect(process.env.GEZEL_SD_SERVER_BIN).toBe('/already/set/sd-server');
    for (const entry of result.binaries) {
      expect(entry.source).toBe('pre-set');
    }
    expect(result.llamaBackend).toBeUndefined();
  });

  it('still publishes detected backend + vendor even when no binary is bundled', () => {
    // Linux NVIDIA host, but no native-bin dir mounted — happens in
    // bare CLI launches (the CLI doesn't stamp GEZEL_NATIVE_BIN_DIR).
    // The Settings dropdown still needs detected-backend / vendor so
    // the user can see what hardware they're on.
    const result = discoverNativeBinaries({
      home,
      platform: 'linux',
      arch: 'x64',
      llamaProbeOverride: {
        fileExists: (p) => p === '/usr/lib/x86_64-linux-gnu/libcuda.so.1',
        readDir: (p) => (p === '/sys/class/drm' ? ['card0'] : []),
        readFileText: (p) => (p === '/sys/class/drm/card0/device/vendor' ? '0x10de\n' : undefined),
      },
    });

    expect(process.env.GEZEL_LLAMA_DETECTED_BACKEND).toBe('cuda');
    expect(process.env.GEZEL_LLAMA_DETECTED_VENDOR).toBe('nvidia');
    expect(process.env.GEZEL_LLAMA_SERVER_BIN).toBeUndefined();
    expect(result.binaries.find((b) => b.name === 'llama-server')?.source).toBe(
      'no-native-bin-dir',
    );
  });

  it('returns no-platform-key entries on unsupported platforms', () => {
    const result = discoverNativeBinaries({
      home,
      nativeBinDirOverride: nativeBinDir,
      platform: 'freebsd' as NodeJS.Platform,
      arch: 'x64',
    });

    for (const entry of result.binaries) {
      expect(entry.source).toBe('no-platform-key');
    }
    expect(result.llamaBackend).toBeUndefined();
  });
});

describe('discoverNativeBinaries — Apple Silicon', () => {
  it('picks Metal and resolves the variant-less darwin-arm64 subdir', () => {
    // Mac ships one llama-server binary (Metal); the discover code's
    // variant fallback resolves <root>/darwin-arm64/ when the
    // -metal subdir is missing.
    const llamaBin = stageBinary(nativeBinDir, 'darwin-arm64', 'llama-server', 'darwin');
    const uvBin = stageBinary(nativeBinDir, 'darwin-arm64', 'uv', 'darwin');

    const result = discoverNativeBinaries({
      home,
      nativeBinDirOverride: nativeBinDir,
      platform: 'darwin',
      arch: 'arm64',
    });

    expect(process.env.GEZEL_LLAMA_SERVER_BIN).toBe(llamaBin);
    expect(process.env.GEZEL_LLAMA_SERVER_BACKEND).toBe('metal');
    expect(process.env.GEZEL_UV_BIN).toBe(uvBin);
    expect(result.llamaBackend?.backend).toBe('metal');
  });
});

describe('discoverNativeBinaries — Linux + AMD Vulkan', () => {
  it('probes Vulkan and resolves the vulkan llama-server', () => {
    const llamaBin = stageBinary(nativeBinDir, 'linux-x64-vulkan', 'llama-server', 'linux');

    const result = discoverNativeBinaries({
      home,
      nativeBinDirOverride: nativeBinDir,
      platform: 'linux',
      arch: 'x64',
      llamaProbeOverride: {
        // No CUDA, has Vulkan loader.
        fileExists: (p) => p === '/usr/lib/x86_64-linux-gnu/libvulkan.so.1',
        readDir: (p) => (p === '/sys/class/drm' ? ['card0'] : []),
        readFileText: (p) => (p === '/sys/class/drm/card0/device/vendor' ? '0x1002\n' : undefined),
      },
    });

    expect(process.env.GEZEL_LLAMA_SERVER_BIN).toBe(llamaBin);
    expect(process.env.GEZEL_LLAMA_SERVER_BACKEND).toBe('vulkan');
    expect(process.env.GEZEL_LLAMA_DETECTED_VENDOR).toBe('amd');
    expect(result.llamaBackend?.backend).toBe('vulkan');
  });
});

describe('discoverNativeBinaries — Linux ARM64 packaging fallback', () => {
  it('uses the CPU build when Vulkan is detected but no ARM64 Vulkan build is bundled', () => {
    const cpuBin = stageBinary(nativeBinDir, 'linux-arm64-cpu', 'gezel-llama-server', 'linux');

    const result = discoverNativeBinaries({
      home,
      nativeBinDirOverride: nativeBinDir,
      platform: 'linux',
      arch: 'arm64',
      llamaProbeOverride: {
        fileExists: (p) => p === '/usr/lib/aarch64-linux-gnu/libvulkan.so.1',
      },
    });

    expect(process.env.GEZEL_LLAMA_SERVER_BIN).toBe(cpuBin);
    expect(process.env.GEZEL_LLAMA_SERVER_BACKEND).toBe('cpu');
    expect(process.env.GEZEL_LLAMA_DETECTED_BACKEND).toBe('vulkan');
    expect(result.llamaBackend).toMatchObject({
      backend: 'cpu',
      detectedBackend: 'vulkan',
    });
    expect(result.llamaBackend?.reason).toContain('no bundled vulkan binary, using cpu');
    expect(result.binaries.find((b) => b.name === 'llama-server')).toMatchObject({
      source: 'discovered',
      path: cpuBin,
      variant: 'cpu',
    });
  });

  it('does not silently replace an explicit Vulkan override with CPU', () => {
    stageBinary(nativeBinDir, 'linux-arm64-cpu', 'gezel-llama-server', 'linux');

    const result = discoverNativeBinaries({
      home,
      nativeBinDirOverride: nativeBinDir,
      platform: 'linux',
      arch: 'arm64',
      llamaCppBackendOverride: 'vulkan',
      llamaProbeOverride: {
        fileExists: (p) => p === '/usr/lib/aarch64-linux-gnu/libvulkan.so.1',
      },
    });

    expect(process.env.GEZEL_LLAMA_SERVER_BIN).toBeUndefined();
    expect(process.env.GEZEL_LLAMA_SERVER_BACKEND).toBeUndefined();
    expect(process.env.GEZEL_LLAMA_DETECTED_BACKEND).toBe('vulkan');
    expect(result.binaries.find((b) => b.name === 'llama-server')).toMatchObject({
      source: 'not-found',
      variant: 'vulkan',
    });
  });
});

describe('discoverNativeBinaries — automatic backend cascade', () => {
  it('falls back from CUDA to Vulkan before CPU when the CUDA build is absent', () => {
    const vulkanBin = stageBinary(nativeBinDir, 'linux-x64-vulkan', 'gezel-llama-server', 'linux');
    stageBinary(nativeBinDir, 'linux-x64-cpu', 'gezel-llama-server', 'linux');

    const result = discoverNativeBinaries({
      home,
      nativeBinDirOverride: nativeBinDir,
      platform: 'linux',
      arch: 'x64',
      llamaProbeOverride: {
        fileExists: (p) => p === '/usr/lib/x86_64-linux-gnu/libcuda.so.1',
      },
    });

    expect(process.env.GEZEL_LLAMA_SERVER_BIN).toBe(vulkanBin);
    expect(process.env.GEZEL_LLAMA_SERVER_BACKEND).toBe('vulkan');
    expect(process.env.GEZEL_LLAMA_DETECTED_BACKEND).toBe('cuda');
    expect(result.llamaBackend).toMatchObject({
      backend: 'vulkan',
      detectedBackend: 'cuda',
    });
    expect(result.binaries.find((b) => b.name === 'llama-server')).toMatchObject({
      source: 'discovered',
      path: vulkanBin,
      variant: 'vulkan',
    });
  });

  it('falls through a missing Vulkan build to CPU when CUDA is also absent', () => {
    const cpuBin = stageBinary(nativeBinDir, 'linux-x64-cpu', 'gezel-llama-server', 'linux');

    const result = discoverNativeBinaries({
      home,
      nativeBinDirOverride: nativeBinDir,
      platform: 'linux',
      arch: 'x64',
      llamaProbeOverride: {
        fileExists: (p) => p === '/usr/lib/x86_64-linux-gnu/libcuda.so.1',
      },
    });

    expect(process.env.GEZEL_LLAMA_SERVER_BIN).toBe(cpuBin);
    expect(process.env.GEZEL_LLAMA_SERVER_BACKEND).toBe('cpu');
    expect(process.env.GEZEL_LLAMA_DETECTED_BACKEND).toBe('cuda');
    expect(result.llamaBackend).toMatchObject({
      backend: 'cpu',
      detectedBackend: 'cuda',
    });
  });
});

describe('discoverNativeBinaries — override', () => {
  it('honours config.llamaCppBackendOverride for the chosen variant', () => {
    // CUDA driver present, but user pinned CPU. Should resolve the
    // CPU binary, not the CUDA one.
    const cpuBin = stageBinary(nativeBinDir, 'win32-x64-cpu', 'llama-server', 'win32');

    const result = discoverNativeBinaries({
      home,
      nativeBinDirOverride: nativeBinDir,
      platform: 'win32',
      arch: 'x64',
      llamaCppBackendOverride: 'cpu',
      llamaProbeOverride: {
        fileExists: (p) => p.endsWith('nvcuda.dll'),
      },
    });

    expect(process.env.GEZEL_LLAMA_SERVER_BIN).toBe(cpuBin);
    expect(process.env.GEZEL_LLAMA_SERVER_BACKEND).toBe('cpu');
    // detected stays cuda — the dropdown still needs to offer the upgrade.
    expect(process.env.GEZEL_LLAMA_DETECTED_BACKEND).toBe('cuda');
    expect(result.llamaBackend?.backend).toBe('cpu');
    expect(result.llamaBackend?.detectedBackend).toBe('cuda');
  });
});
