import { describe, expect, it } from 'vitest';
import { evaluateApiCompat, readApiCompatEvidence } from './api-compat.js';

const health = (over: Record<string, unknown> = {}) => ({
  version: '1.26245.7',
  apiCompat: { floor: 1, current: 1 },
  ...over,
});

describe('evaluateApiCompat', () => {
  it('adopts a service whose generation range contains ours', () => {
    expect(evaluateApiCompat(health(), { clientGeneration: 1 })).toEqual({ compatible: true });
  });

  it('adopts across differing product versions', () => {
    // The whole point: clients and daemons ship on different schedules, so a
    // version difference is the normal case and must not be a verdict.
    const verdict = evaluateApiCompat(health({ version: '1.99999.1' }), { clientGeneration: 1 });
    expect(verdict.compatible).toBe(true);
  });

  // 2026-10-06: a 1.26226.50 autostart daemon from August, against a
  // 1.26279.87 install. The August build predates the handshake.
  it('declines a service that predates the handshake, and accepts one that has it', () => {
    const stale = readApiCompatEvidence({ ok: true, version: '1.26226.50' });
    const current = readApiCompatEvidence({
      ok: true,
      version: '1.26279.87',
      apiCompat: { floor: 1, current: 1 },
    });
    expect(evaluateApiCompat(stale, { client: 'this gezel CLI' })).toEqual({
      compatible: false,
      code: 'no-handshake',
      reason: 'the Gezel service (1.26226.50) is older than this gezel CLI can connect to',
    });
    expect(evaluateApiCompat(current, { client: 'this gezel CLI' })).toEqual({ compatible: true });
  });

  it('declines the machine-engine broker, which has no product API', () => {
    const verdict = evaluateApiCompat(health({ serviceRole: 'machine-engine' }));
    expect(verdict).toMatchObject({ compatible: false, code: 'machine-engine-role' });
  });

  it('says the client needs updating when the service stopped serving its generation', () => {
    const verdict = evaluateApiCompat(health({ apiCompat: { floor: 3, current: 4 } }), {
      clientGeneration: 2,
    });
    expect(verdict).toMatchObject({ compatible: false, code: 'client-too-old' });
    expect(verdict.compatible === false && verdict.reason).toContain('3-4');
  });

  it('says the service needs updating when it does not serve our generation yet', () => {
    const verdict = evaluateApiCompat(health({ apiCompat: { floor: 1, current: 1 } }), {
      clientGeneration: 2,
    });
    expect(verdict).toMatchObject({ compatible: false, code: 'service-too-old' });
  });

  it('adopts anywhere inside a widened range', () => {
    // A service that still serves older generations is the normal upgrade
    // path; every generation in the window must be adoptable.
    for (const clientGeneration of [1, 2, 3]) {
      expect(
        evaluateApiCompat(health({ apiCompat: { floor: 1, current: 3 } }), { clientGeneration })
          .compatible,
      ).toBe(true);
    }
  });
});

describe('readApiCompatEvidence', () => {
  it('reads absent or malformed ranges as no handshake', () => {
    for (const body of [
      null,
      'ok',
      { apiCompat: { floor: '1', current: 1 } },
      { apiCompat: { floor: 1.5, current: 2 } },
      { apiCompat: null },
    ]) {
      expect(evaluateApiCompat(readApiCompatEvidence(body))).toMatchObject({
        compatible: false,
        code: 'no-handshake',
      });
    }
  });

  it('keeps the role, so a broker answering a product probe is declined', () => {
    expect(
      readApiCompatEvidence({ serviceRole: 'machine-engine', apiCompat: { floor: 1, current: 1 } }),
    ).toEqual({ serviceRole: 'machine-engine', apiCompat: { floor: 1, current: 1 } });
  });
});
