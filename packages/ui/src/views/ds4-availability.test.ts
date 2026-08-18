import { describe, expect, it } from 'vitest';
import { detectDs4Availability } from './ds4-availability.js';

const nav = (platform: string, userAgent: string, arch?: string): Navigator =>
  ({
    platform,
    userAgent,
    ...(arch ? { userAgentData: { architecture: arch } } : {}),
  }) as unknown as Navigator;

const GIB = 1024 ** 3;

describe('detectDs4Availability', () => {
  it('external URL wins on every platform (even Windows)', () => {
    const r = detectDs4Availability({
      externalBaseUrl: 'http://127.0.0.1:8000',
      navigatorOverride: nav('Win32', 'Windows NT 10'),
    });
    expect(r.status).toBe('external');
  });

  it('Apple Silicon → available (metal)', () => {
    const r = detectDs4Availability({ navigatorOverride: nav('MacIntel', 'Mac Apple', 'arm') });
    expect(r.status).toBe('available');
    if (r.status === 'available') expect(r.backend).toBe('metal');
  });

  it('Intel Mac → unavailable (no unified-memory Metal)', () => {
    const r = detectDs4Availability({
      navigatorOverride: nav('MacIntel', 'Mozilla Macintosh Intel'),
    });
    expect(r.status).toBe('unavailable');
  });

  it('Windows → unavailable (no native build)', () => {
    const r = detectDs4Availability({ navigatorOverride: nav('Win32', 'Windows NT 10') });
    expect(r.status).toBe('unavailable');
  });

  it('Linux → requires-cuda when the daemon reports nothing (browser can’t see the GPU)', () => {
    const r = detectDs4Availability({
      navigatorOverride: nav('Linux x86_64', 'X11; Linux x86_64'),
    });
    expect(r.status).toBe('requires-cuda');
  });

  it('under the RAM floor → unavailable, even on an otherwise-capable Mac', () => {
    const r = detectDs4Availability({
      navigatorOverride: nav('MacIntel', 'Mac Apple', 'arm'),
      totalRamBytes: 32 * GIB,
    });
    expect(r.status).toBe('unavailable');
    if (r.status === 'unavailable') expect(r.reason).toContain('48 GB');
  });

  it('under the RAM floor → unavailable on Linux too (the check precedes CUDA)', () => {
    const r = detectDs4Availability({
      navigatorOverride: nav('Linux x86_64', 'X11; Linux x86_64'),
      totalRamBytes: 16 * GIB,
    });
    expect(r.status).toBe('unavailable');
  });

  // Linux `os.totalmem()` reports MemTotal, which is short of the sticker
  // figure — a real 48 GB box lands near 47 GiB and must still qualify.
  it('a 48 GB machine reporting 47 GiB still qualifies', () => {
    const r = detectDs4Availability({
      navigatorOverride: nav('MacIntel', 'Mac Apple', 'arm'),
      totalRamBytes: 47 * GIB,
    });
    expect(r.status).toBe('available');
  });

  it('unknown RAM is not treated as too little', () => {
    const r = detectDs4Availability({ navigatorOverride: nav('MacIntel', 'Mac Apple', 'arm') });
    expect(r.status).toBe('available');
  });

  it('an external server wins over the RAM floor', () => {
    const r = detectDs4Availability({
      externalBaseUrl: 'http://127.0.0.1:8000',
      navigatorOverride: nav('MacIntel', 'Mac Apple', 'arm'),
      totalRamBytes: 8 * GIB,
    });
    expect(r.status).toBe('external');
  });
});

/**
 * The wild-caught bug: on a DGX Spark (linux-arm64, 122 GB, CUDA, ds4-server
 * bundled and a DeepSeek download already running) the panel said "requires
 * NVIDIA / CUDA" — because the gate only ever looked at `navigator.platform`,
 * whose Linux branch is unconditional. The llama.cpp tab beside it read `cuda`
 * from a real probe the whole time.
 */
describe('detectDs4Availability — driven by daemon facts', () => {
  const linuxNav = nav('Linux aarch64', 'X11; Linux aarch64');

  it('a bundled CUDA engine plus an NVIDIA probe is available, not a hedge', () => {
    const r = detectDs4Availability({
      navigatorOverride: linuxNav,
      ds4ServerBundled: true,
      serverPlatform: 'linux',
      detectedBackend: 'cuda',
      gpuVendor: 'nvidia',
    });
    expect(r.status).toBe('available');
    if (r.status === 'available') expect(r.backend).toBe('cuda');
  });

  it('accepts the vendor hint alone, so a user-pinned non-CUDA backend still reads available', () => {
    // Pinning llama.cpp to Vulkan or CPU is a llama.cpp decision; it says
    // nothing about whether the NVIDIA driver ds4 needs is present.
    const r = detectDs4Availability({
      navigatorOverride: linuxNav,
      ds4ServerBundled: true,
      serverPlatform: 'linux',
      detectedBackend: 'vulkan',
      gpuVendor: 'nvidia',
    });
    expect(r.status).toBe('available');
  });

  it('names an AMD or Intel GPU as the blocker instead of hedging', () => {
    const r = detectDs4Availability({
      navigatorOverride: linuxNav,
      ds4ServerBundled: true,
      serverPlatform: 'linux',
      detectedBackend: 'vulkan',
      gpuVendor: 'amd',
    });
    expect(r.status).toBe('unavailable');
    if (r.status === 'unavailable') expect(r.reason).toContain('AMD');
  });

  it('keeps the hedge only when the build is present and no driver was detected', () => {
    const r = detectDs4Availability({
      navigatorOverride: linuxNav,
      ds4ServerBundled: true,
      serverPlatform: 'linux',
    });
    expect(r.status).toBe('requires-cuda');
    if (r.status === 'requires-cuda') expect(r.reason).toContain('no NVIDIA driver was detected');
  });

  it('no bundled engine is a verdict, and says the engine is missing', () => {
    const r = detectDs4Availability({
      navigatorOverride: linuxNav,
      ds4ServerBundled: false,
      serverPlatform: 'linux',
    });
    expect(r.status).toBe('unavailable');
    if (r.status === 'unavailable') expect(r.reason).toContain('no DwarfStar engine installed');
  });

  it('a bundled macOS engine proves Apple Silicon without asking the browser', () => {
    // ds4 ships Metal only for darwin-arm64, so the binary's presence is the
    // architecture check — no userAgent sniffing needed.
    const r = detectDs4Availability({
      navigatorOverride: nav('MacIntel', 'Mozilla Macintosh Intel'),
      ds4ServerBundled: true,
      serverPlatform: 'darwin',
    });
    expect(r.status).toBe('available');
    if (r.status === 'available') expect(r.backend).toBe('metal');
  });

  it('reports the Windows/WSL2 route from the daemon platform, not the user agent', () => {
    const r = detectDs4Availability({
      navigatorOverride: nav('Linux x86_64', 'X11; Linux x86_64'),
      ds4ServerBundled: false,
      serverPlatform: 'win32',
    });
    expect(r.status).toBe('unavailable');
    if (r.status === 'unavailable') expect(r.reason).toContain('WSL2');
  });

  it('still gates on RAM ahead of every daemon fact', () => {
    const r = detectDs4Availability({
      navigatorOverride: linuxNav,
      ds4ServerBundled: true,
      serverPlatform: 'linux',
      detectedBackend: 'cuda',
      gpuVendor: 'nvidia',
      totalRamBytes: 16 * GIB,
    });
    expect(r.status).toBe('unavailable');
    if (r.status === 'unavailable') expect(r.reason).toContain('48 GB');
  });

  it('an external server still wins over a machine with no engine', () => {
    const r = detectDs4Availability({
      externalBaseUrl: 'http://127.0.0.1:8000',
      navigatorOverride: linuxNav,
      ds4ServerBundled: false,
      serverPlatform: 'win32',
    });
    expect(r.status).toBe('external');
  });
});
