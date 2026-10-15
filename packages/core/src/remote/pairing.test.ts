import { describe, expect, it } from 'vitest';
import { normalizePairingCode, normalizeServerOrigin } from './pairing.js';

describe('normalizeServerOrigin', () => {
  it('reads a bare address as HTTPS on the serving port', () => {
    expect(normalizeServerOrigin('192.168.1.50')).toBe('https://192.168.1.50:6229');
    expect(normalizeServerOrigin(' 192.168.1.50:7000 ')).toBe('https://192.168.1.50:7000');
    expect(normalizeServerOrigin('[fe80::1]')).toBe('https://[fe80::1]:6229');
  });

  it('keeps an origin that is already exact', () => {
    expect(normalizeServerOrigin('https://10.0.0.4:6229')).toBe('https://10.0.0.4:6229');
    expect(normalizeServerOrigin('https://10.0.0.4:6229/')).toBe('https://10.0.0.4:6229');
  });

  it('refuses names, plain HTTP, and paths', () => {
    expect(() => normalizeServerOrigin('werkbank.local')).toThrow(/IP address/);
    expect(() => normalizeServerOrigin('http://10.0.0.4:6229')).toThrow(/https/);
    expect(() => normalizeServerOrigin('https://10.0.0.4:6229/v1')).toThrow(/https/);
  });
});

describe('normalizePairingCode', () => {
  it('accepts the code however it was typed', () => {
    expect(normalizePairingCode('4821 0937')).toBe('48210937');
    expect(normalizePairingCode('4821-0937')).toBe('48210937');
    expect(normalizePairingCode('482109')).toBeNull();
  });
});
