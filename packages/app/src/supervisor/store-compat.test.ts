import { describe, expect, it } from 'vitest';
import { evaluateStoreCompat } from './store-compat.js';

const health = (over: Record<string, unknown> = {}) =>
  ({
    ok: true,
    version: '1.26245.7',
    startedAt: new Date().toISOString(),
    nodeVersion: 'v24.0.0',
    platform: 'darwin',
    ds4ServerBundled: false,
    embeddings: { status: 'ready' },
    apiCompat: { floor: 1, current: 1 },
    ...over,
    // biome-ignore lint/suspicious/noExplicitAny: test fixture stands in for the wire type
  }) as any;

describe('evaluateStoreCompat', () => {
  it('adopts a service whose generation range contains ours', () => {
    expect(evaluateStoreCompat(health(), 1)).toEqual({ compatible: true });
  });

  it('adopts across differing product versions', () => {
    // The whole point: the two channels ship on different schedules, so a
    // version difference is the normal case and must not be a verdict.
    const verdict = evaluateStoreCompat(health({ version: '1.99999.1' }), 1);
    expect(verdict.compatible).toBe(true);
  });

  it('declines a service that predates the handshake', () => {
    // Absence is a verdict, not silence — a daemon with no apiCompat is older
    // than any generation we could negotiate.
    const verdict = evaluateStoreCompat(health({ apiCompat: undefined }), 1);
    expect(verdict).toMatchObject({ compatible: false, code: 'no-handshake' });
  });

  it('declines the machine-engine broker, which has no product API', () => {
    const verdict = evaluateStoreCompat(health({ serviceRole: 'machine-engine' }), 1);
    expect(verdict).toMatchObject({ compatible: false, code: 'machine-engine-role' });
  });

  it('declines a service too new to still serve our generation', () => {
    const verdict = evaluateStoreCompat(health({ apiCompat: { floor: 3, current: 4 } }), 2);
    expect(verdict).toMatchObject({ compatible: false, code: 'generation-mismatch' });
    expect(verdict.compatible === false && verdict.reason).toContain('3-4');
  });

  it('declines a service too old to serve our generation yet', () => {
    const verdict = evaluateStoreCompat(health({ apiCompat: { floor: 1, current: 1 } }), 2);
    expect(verdict).toMatchObject({ compatible: false, code: 'generation-mismatch' });
  });

  it('adopts anywhere inside a widened range', () => {
    // A service that still serves older generations is the normal upgrade
    // path; every generation in the window must be adoptable.
    for (const generation of [1, 2, 3]) {
      expect(
        evaluateStoreCompat(health({ apiCompat: { floor: 1, current: 3 } }), generation).compatible,
      ).toBe(true);
    }
  });
});
