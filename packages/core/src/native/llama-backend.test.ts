import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectLlamaBackend } from './llama-backend.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gezel-llama-backend-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** Build a `probe` that asserts presence by membership in a set. */
function probeWith(present: string[]): {
  fileExists: (p: string) => boolean;
  commandOk: () => boolean;
} {
  const set = new Set(present);
  return {
    fileExists: (p) => set.has(p),
    commandOk: () => false,
  };
}

/**
 * Build a `probe` that fakes Linux PCI sysfs vendor lookups. Pass a map
 * of `card<n>` → vendor string (e.g. `'0x1002'`). The fake `readDir`
 * returns the keys; `readFileText` returns the value when called with
 * `/sys/class/drm/<card>/device/vendor`.
 */
function vendorSysfsProbe(devices: Record<string, string>): {
  readFileText: (p: string) => string | undefined;
  readDir: (p: string) => string[];
} {
  return {
    readDir: (p) => (p === '/sys/class/drm' ? Object.keys(devices) : []),
    readFileText: (p) => {
      const m = p.match(/^\/sys\/class\/drm\/(card\d+)\/device\/vendor$/);
      const card = m?.[1];
      if (!card) return undefined;
      const v = devices[card];
      return v ? `${v}\n` : undefined;
    },
  };
}

describe('detectLlamaBackend — Linux x64', () => {
  it('picks cuda when libcuda.so.1 is present', () => {
    const r = detectLlamaBackend({
      engineVersion: 'b8892',
      home,
      probe: {
        ...probeWith(['/usr/lib/x86_64-linux-gnu/libcuda.so.1']),
        platform: 'linux',
        arch: 'x64',
      },
    });
    expect(r.backend).toBe('cuda');
    expect(r.reason).toContain('libcuda.so.1');
    expect(r.cached).toBe(false);
  });

  it('picks vulkan when only libvulkan loader present', () => {
    const r = detectLlamaBackend({
      engineVersion: 'b8892',
      home,
      probe: {
        ...probeWith(['/usr/lib/x86_64-linux-gnu/libvulkan.so.1']),
        platform: 'linux',
        arch: 'x64',
      },
    });
    expect(r.backend).toBe('vulkan');
  });

  it('falls back to cpu when neither driver/loader is present', () => {
    const r = detectLlamaBackend({
      engineVersion: 'b8892',
      home,
      probe: { ...probeWith([]), platform: 'linux', arch: 'x64' },
    });
    expect(r.backend).toBe('cpu');
  });

  it('cuda wins over vulkan when both are available', () => {
    const r = detectLlamaBackend({
      engineVersion: 'b8892',
      home,
      probe: {
        ...probeWith([
          '/usr/lib/x86_64-linux-gnu/libcuda.so.1',
          '/usr/lib/x86_64-linux-gnu/libvulkan.so.1',
        ]),
        platform: 'linux',
        arch: 'x64',
      },
    });
    expect(r.backend).toBe('cuda');
  });
});

describe('detectLlamaBackend — Linux arm64', () => {
  it('picks cuda when libcuda.so.1 is at the aarch64 multiarch path (DGX Spark / Jetson)', () => {
    const r = detectLlamaBackend({
      engineVersion: 'b8892',
      home,
      probe: {
        ...probeWith(['/usr/lib/aarch64-linux-gnu/libcuda.so.1']),
        platform: 'linux',
        arch: 'arm64',
      },
    });
    expect(r.backend).toBe('cuda');
    expect(r.reason).toContain('aarch64-linux-gnu/libcuda.so.1');
  });

  it('picks vulkan when only the aarch64 vulkan loader is present', () => {
    const r = detectLlamaBackend({
      engineVersion: 'b8892',
      home,
      probe: {
        ...probeWith(['/usr/lib/aarch64-linux-gnu/libvulkan.so.1']),
        platform: 'linux',
        arch: 'arm64',
      },
    });
    expect(r.backend).toBe('vulkan');
  });

  it('falls back to cpu on arm64 when neither driver is present', () => {
    const r = detectLlamaBackend({
      engineVersion: 'b8892',
      home,
      probe: { ...probeWith([]), platform: 'linux', arch: 'arm64' },
    });
    expect(r.backend).toBe('cpu');
    // Regression guard: before the arm64 dispatch landed, this fell
    // through the "unsupported platform" branch with a different
    // reason string. The CUDA-path-but-not-found case should still
    // hit the normal "no driver" message.
    expect(r.reason).toContain('no CUDA driver');
  });
});

describe('detectLlamaBackend — Windows x64', () => {
  // Pre-compute the System32 paths the probe will look for.
  const sys32 = process.env.SYSTEMROOT
    ? join(process.env.SYSTEMROOT, 'System32')
    : 'C:\\Windows\\System32';

  it('picks cuda when nvcuda.dll is present', () => {
    const r = detectLlamaBackend({
      engineVersion: 'b8892',
      home,
      probe: { ...probeWith([join(sys32, 'nvcuda.dll')]), platform: 'win32', arch: 'x64' },
    });
    expect(r.backend).toBe('cuda');
  });

  it('picks vulkan when only vulkan-1.dll present', () => {
    const r = detectLlamaBackend({
      engineVersion: 'b8892',
      home,
      probe: { ...probeWith([join(sys32, 'vulkan-1.dll')]), platform: 'win32', arch: 'x64' },
    });
    expect(r.backend).toBe('vulkan');
  });

  it('falls back to cpu when neither driver is present', () => {
    const r = detectLlamaBackend({
      engineVersion: 'b8892',
      home,
      probe: { ...probeWith([]), platform: 'win32', arch: 'x64' },
    });
    expect(r.backend).toBe('cpu');
  });
});

describe('detectLlamaBackend — Mac', () => {
  it('Apple Silicon → metal, no probe needed', () => {
    const r = detectLlamaBackend({
      engineVersion: 'b8892',
      home,
      probe: { ...probeWith([]), platform: 'darwin', arch: 'arm64' },
    });
    expect(r.backend).toBe('metal');
    expect(r.reason).toContain('Apple Silicon');
  });

  it('Intel Mac → cpu fallback', () => {
    const r = detectLlamaBackend({
      engineVersion: 'b8892',
      home,
      probe: { ...probeWith([]), platform: 'darwin', arch: 'x64' },
    });
    expect(r.backend).toBe('cpu');
    expect(r.reason).toContain('Intel Mac');
  });
});

describe('detectLlamaBackend — caching', () => {
  it('persists the result and returns cached=true on the second call', () => {
    const opts = {
      engineVersion: 'b8892',
      home,
      probe: { ...probeWith([]), platform: 'darwin' as const, arch: 'arm64' as const },
    };
    const first = detectLlamaBackend(opts);
    expect(first.cached).toBe(false);

    const cacheFile = join(home, 'engines', 'llama-cpp', 'backend.json');
    const onDisk = JSON.parse(readFileSync(cacheFile, 'utf8'));
    expect(onDisk.backend).toBe('metal');
    expect(onDisk.engineVersion).toBe('b8892');

    const second = detectLlamaBackend(opts);
    expect(second.cached).toBe(true);
    expect(second.backend).toBe('metal');
    expect(second.reason).toContain('cached');
  });

  it('invalidates the cache when engineVersion changes', () => {
    detectLlamaBackend({
      engineVersion: 'b8892',
      home,
      probe: { ...probeWith([]), platform: 'darwin', arch: 'arm64' },
    });
    const bumped = detectLlamaBackend({
      engineVersion: 'b9000',
      home,
      probe: { ...probeWith([]), platform: 'darwin', arch: 'arm64' },
    });
    expect(bumped.cached).toBe(false);
  });

  it('re-probes when an NVIDIA driver appears after a cached Vulkan result', () => {
    const vulkanOnly = detectLlamaBackend({
      engineVersion: 'b8892',
      home,
      probe: {
        ...probeWith(['/usr/lib/x86_64-linux-gnu/libvulkan.so.1']),
        ...vendorSysfsProbe({ card0: '0x10de' }),
        platform: 'linux',
        arch: 'x64',
      },
    });
    expect(vulkanOnly).toMatchObject({
      backend: 'vulkan',
      vendorHint: 'nvidia',
      cached: false,
    });

    const afterDriverInstall = detectLlamaBackend({
      engineVersion: 'b8892',
      home,
      probe: {
        ...probeWith([
          '/usr/lib/x86_64-linux-gnu/libcuda.so.1',
          '/usr/lib/x86_64-linux-gnu/libvulkan.so.1',
        ]),
        ...vendorSysfsProbe({ card0: '0x10de' }),
        platform: 'linux',
        arch: 'x64',
      },
    });
    expect(afterDriverInstall).toMatchObject({
      backend: 'cuda',
      detectedBackend: 'cuda',
      vendorHint: 'nvidia',
      cached: false,
    });
  });

  it('re-probes when the on-disk cache predates the current probeSchemaVersion', () => {
    // Simulate a cache file written by an older Gezel build that
    // didn't know about the linux-arm64 dispatch — same engineVersion,
    // but no probeSchemaVersion field. The fix would be invisible to
    // affected users without this invalidation: their cached `cpu`
    // would survive forever even with a working CUDA driver.
    const cacheDir = join(home, 'engines', 'llama-cpp');
    require('node:fs').mkdirSync(cacheDir, { recursive: true });
    require('node:fs').writeFileSync(
      join(cacheDir, 'backend.json'),
      JSON.stringify({
        engineVersion: 'b8892',
        backend: 'cpu',
        reason: 'no CUDA driver and no Vulkan loader found',
        probedAt: '2026-01-01T00:00:00.000Z',
      }),
    );
    const r = detectLlamaBackend({
      engineVersion: 'b8892',
      home,
      probe: {
        ...probeWith(['/usr/lib/aarch64-linux-gnu/libcuda.so.1']),
        platform: 'linux',
        arch: 'arm64',
      },
    });
    expect(r.cached).toBe(false);
    expect(r.backend).toBe('cuda');
    // The freshly-written cache should carry the new schema version.
    const written = JSON.parse(
      readFileSync(join(home, 'engines', 'llama-cpp', 'backend.json'), 'utf8'),
    );
    expect(written.probeSchemaVersion).toBe(1);
  });

  it('tolerates a corrupt cache file by re-probing', () => {
    const cacheDir = join(home, 'engines', 'llama-cpp');
    require('node:fs').mkdirSync(cacheDir, { recursive: true });
    require('node:fs').writeFileSync(join(cacheDir, 'backend.json'), '{not json');
    const r = detectLlamaBackend({
      engineVersion: 'b8892',
      home,
      probe: { ...probeWith([]), platform: 'darwin', arch: 'arm64' },
    });
    expect(r.cached).toBe(false);
    expect(r.backend).toBe('metal');
  });
});

describe('detectLlamaBackend — override + detectedBackend', () => {
  // The split that motivates these tests: `backend` is what the
  // supervisor should USE (override-applied), `detectedBackend` is what
  // the hardware actually supports. Without the split, a `cpu` pin on a
  // CUDA box would lock the user out of the GPU options in Settings.
  const sys32 = process.env.SYSTEMROOT
    ? join(process.env.SYSTEMROOT, 'System32')
    : 'C:\\Windows\\System32';

  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'gezel-llama-backend-override-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('with no override, backend === detectedBackend', () => {
    const r = detectLlamaBackend({
      engineVersion: 'b8892',
      home,
      probe: { ...probeWith([join(sys32, 'nvcuda.dll')]), platform: 'win32', arch: 'x64' },
    });
    expect(r.backend).toBe('cuda');
    expect(r.detectedBackend).toBe('cuda');
  });

  it('with override=cpu on a CUDA box: backend=cpu, detectedBackend=cuda', () => {
    const r = detectLlamaBackend({
      engineVersion: 'b8892',
      home,
      override: 'cpu',
      probe: { ...probeWith([join(sys32, 'nvcuda.dll')]), platform: 'win32', arch: 'x64' },
    });
    expect(r.backend).toBe('cpu');
    expect(r.detectedBackend).toBe('cuda');
    expect(r.reason).toContain('pinned by config.llamaCppBackendOverride=cpu');
    expect(r.reason).toContain('hardware probe: found');
  });

  it('with override=auto, behaves like no override', () => {
    const r = detectLlamaBackend({
      engineVersion: 'b8892',
      home,
      override: 'auto',
      probe: { ...probeWith([join(sys32, 'vulkan-1.dll')]), platform: 'win32', arch: 'x64' },
    });
    expect(r.backend).toBe('vulkan');
    expect(r.detectedBackend).toBe('vulkan');
  });

  it('override path still hits the cache for the probe (no double-cost)', () => {
    // Seed the cache by running auto first.
    const opts = {
      engineVersion: 'b8892',
      home,
      probe: {
        ...probeWith([join(sys32, 'nvcuda.dll')]),
        platform: 'win32' as const,
        arch: 'x64' as const,
      },
    };
    detectLlamaBackend(opts);
    // Now an override call should report cached=true (the probe came from cache).
    const r = detectLlamaBackend({ ...opts, override: 'cpu' });
    expect(r.backend).toBe('cpu');
    expect(r.detectedBackend).toBe('cuda');
    expect(r.cached).toBe(true);
  });
});

describe('detectLlamaBackend — GPU vendor hint', () => {
  // Vendor detection is independent of the backend pick. The chief use
  // case is labeling AMD Radeon users on the Vulkan backend as "AMD GPU"
  // instead of the generic "GPU." These tests cover the major (vendor,
  // backend) combinations + cache round-trip.
  const sys32 = process.env.SYSTEMROOT
    ? join(process.env.SYSTEMROOT, 'System32')
    : 'C:\\Windows\\System32';

  it('Linux: AMD GPU on Vulkan backend → vendorHint=amd', () => {
    const r = detectLlamaBackend({
      engineVersion: 'b8892',
      home,
      probe: {
        ...probeWith(['/usr/lib/x86_64-linux-gnu/libvulkan.so.1']),
        ...vendorSysfsProbe({ card0: '0x1002' }),
        platform: 'linux',
        arch: 'x64',
      },
    });
    expect(r.backend).toBe('vulkan');
    expect(r.vendorHint).toBe('amd');
  });

  it('Linux: NVIDIA GPU on CUDA backend → vendorHint=nvidia', () => {
    const r = detectLlamaBackend({
      engineVersion: 'b8892',
      home,
      probe: {
        ...probeWith(['/usr/lib/x86_64-linux-gnu/libcuda.so.1']),
        ...vendorSysfsProbe({ card0: '0x10de' }),
        platform: 'linux',
        arch: 'x64',
      },
    });
    expect(r.backend).toBe('cuda');
    expect(r.vendorHint).toBe('nvidia');
  });

  it('Linux: hybrid laptop (Intel iGPU + NVIDIA discrete) prefers nvidia', () => {
    const r = detectLlamaBackend({
      engineVersion: 'b8892',
      home,
      probe: {
        ...probeWith(['/usr/lib/x86_64-linux-gnu/libcuda.so.1']),
        ...vendorSysfsProbe({ card0: '0x8086', card1: '0x10de' }),
        platform: 'linux',
        arch: 'x64',
      },
    });
    expect(r.vendorHint).toBe('nvidia');
  });

  it('Linux: hybrid laptop (Intel iGPU + AMD discrete) prefers amd', () => {
    const r = detectLlamaBackend({
      engineVersion: 'b8892',
      home,
      probe: {
        ...probeWith(['/usr/lib/x86_64-linux-gnu/libvulkan.so.1']),
        ...vendorSysfsProbe({ card0: '0x8086', card1: '0x1002' }),
        platform: 'linux',
        arch: 'x64',
      },
    });
    expect(r.vendorHint).toBe('amd');
  });

  it('Linux: no /sys/class/drm entries → vendorHint undefined, backend still resolved', () => {
    const r = detectLlamaBackend({
      engineVersion: 'b8892',
      home,
      probe: {
        ...probeWith(['/usr/lib/x86_64-linux-gnu/libvulkan.so.1']),
        ...vendorSysfsProbe({}),
        platform: 'linux',
        arch: 'x64',
      },
    });
    expect(r.backend).toBe('vulkan');
    expect(r.vendorHint).toBeUndefined();
  });

  it('Windows: AMD driver DLL present + Vulkan backend → vendorHint=amd', () => {
    const r = detectLlamaBackend({
      engineVersion: 'b8892',
      home,
      probe: {
        ...probeWith([join(sys32, 'vulkan-1.dll'), join(sys32, 'aticfx64.dll')]),
        platform: 'win32',
        arch: 'x64',
      },
    });
    expect(r.backend).toBe('vulkan');
    expect(r.vendorHint).toBe('amd');
  });

  it('Windows: Intel driver DLL alone → vendorHint=intel, backend=cpu', () => {
    const r = detectLlamaBackend({
      engineVersion: 'b8892',
      home,
      probe: {
        ...probeWith([join(sys32, 'igdumdim64.dll')]),
        platform: 'win32',
        arch: 'x64',
      },
    });
    expect(r.backend).toBe('cpu');
    expect(r.vendorHint).toBe('intel');
  });

  it("macOS: vendorHint not set (Apple Silicon GPU isn't a PCI vendor)", () => {
    const r = detectLlamaBackend({
      engineVersion: 'b8892',
      home,
      probe: { ...probeWith([]), platform: 'darwin', arch: 'arm64' },
    });
    expect(r.backend).toBe('metal');
    expect(r.vendorHint).toBeUndefined();
  });

  it('vendorHint round-trips through the cache file', () => {
    const opts = {
      engineVersion: 'b8892',
      home,
      probe: {
        ...probeWith(['/usr/lib/x86_64-linux-gnu/libvulkan.so.1']),
        ...vendorSysfsProbe({ card0: '0x1002' }),
        platform: 'linux' as const,
        arch: 'x64' as const,
      },
    };
    const first = detectLlamaBackend(opts);
    expect(first.cached).toBe(false);
    expect(first.vendorHint).toBe('amd');

    const second = detectLlamaBackend(opts);
    expect(second.cached).toBe(true);
    expect(second.vendorHint).toBe('amd');
  });
});
