import { describe, expect, it } from 'vitest';
import { ds4MtpArgs, resolveDs4Mtp } from './mtp.js';

describe('DS4 embedded MTP policy', () => {
  it('enables a catalog-declared block under auto', () => {
    const decision = resolveDs4Mtp({ catalog: { exactSampling: true } });
    expect(decision).toMatchObject({ enabled: true, exactSampling: true });
    expect(ds4MtpArgs(decision)).toEqual(['--mtp', '--mtp-exact-sampling']);
  });

  it('does not guess that an older or explicit GGUF has embedded MTP', () => {
    const decision = resolveDs4Mtp({ mode: 'auto' });
    expect(decision.enabled).toBe(false);
    expect(ds4MtpArgs(decision)).toEqual([]);
  });

  it('allows an operator to enable and tune an explicit development GGUF', () => {
    const decision = resolveDs4Mtp({ mode: 'on', exactSampling: true });
    expect(ds4MtpArgs(decision)).toEqual(['--mtp', '--mtp-exact-sampling']);
  });

  it('lets the operator disable a catalog default', () => {
    const decision = resolveDs4Mtp({ mode: 'off', catalog: { exactSampling: true } });
    expect(decision.enabled).toBe(false);
    expect(decision.exactSampling).toBe(false);
  });

  it('does not stack embedded MTP with external DSpark', () => {
    const automatic = resolveDs4Mtp({
      mode: 'auto',
      catalog: { exactSampling: true },
      dsparkEnabled: true,
    });
    expect(automatic.enabled).toBe(false);
    expect(automatic.unmetRequest).toBeUndefined();

    const requested = resolveDs4Mtp({ mode: 'on', dsparkEnabled: true });
    expect(requested.enabled).toBe(false);
    expect(requested.unmetRequest).toMatch(/cannot be combined/i);
  });

  it('allows config to override the catalog exact-sampling recommendation', () => {
    const decision = resolveDs4Mtp({
      catalog: { exactSampling: true },
      exactSampling: false,
    });
    expect(ds4MtpArgs(decision)).toEqual(['--mtp']);
  });
});
