import { describe, expect, it } from 'vitest';
import { detectDs4Availability } from './ds4-availability.js';

const nav = (platform: string, userAgent: string, arch?: string): Navigator =>
  ({
    platform,
    userAgent,
    ...(arch ? { userAgentData: { architecture: arch } } : {}),
  }) as unknown as Navigator;

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

  it('Linux → requires-cuda (browser can’t see the GPU)', () => {
    const r = detectDs4Availability({
      navigatorOverride: nav('Linux x86_64', 'X11; Linux x86_64'),
    });
    expect(r.status).toBe('requires-cuda');
  });
});
