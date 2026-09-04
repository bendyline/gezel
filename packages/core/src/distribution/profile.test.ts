import { describe, expect, it } from 'vitest';
import { type RestrictedFeature, resolveDistributionProfile } from './profile.js';

const FEATURES: RestrictedFeature[] = [
  'playwright',
  'copilot-install',
  'engine-download',
  'python',
  'npm',
];

describe('resolveDistributionProfile', () => {
  it('resolves an unset environment to the unrestricted standard build', () => {
    const policy = resolveDistributionProfile({});
    expect(policy.profile).toBe('standard');
    expect(policy.allowRuntimeCodeDownloads).toBe(true);
    expect(policy.allowEngineBinaryDownloads).toBe(true);
    expect(policy.allowNpmInstalls).toBe(true);
    expect(policy.allowOllamaEmulation).toBe(true);
    expect(policy.pythonProvisioning).toBe('full');
  });

  it('restricts every code-acquisition path under the store profile', () => {
    const policy = resolveDistributionProfile({ GEZEL_DISTRIBUTION_PROFILE: 'store' });
    expect(policy.profile).toBe('store');
    expect(policy.allowRuntimeCodeDownloads).toBe(false);
    expect(policy.allowEngineBinaryDownloads).toBe(false);
    expect(policy.allowNpmInstalls).toBe(false);
    expect(policy.allowOllamaEmulation).toBe(false);
    expect(policy.pythonProvisioning).toBe('frozen-only');
  });

  it('only the exact store label restricts anything', () => {
    for (const value of ['', 'Store', 'STORE', 'store-mas', 'standard', 'true', '1']) {
      const policy = resolveDistributionProfile({ GEZEL_DISTRIBUTION_PROFILE: value });
      expect(policy.profile, `${value} must not resolve to store`).toBe('standard');
    }
  });

  it('gives every restricted feature its own refusal copy under store', () => {
    const policy = resolveDistributionProfile({ GEZEL_DISTRIBUTION_PROFILE: 'store' });
    const reasons = FEATURES.map((feature) => policy.refusalReason(feature));
    for (const reason of reasons) expect(reason.length).toBeGreaterThan(0);
    // Distinct copy per feature: a shared string would send a user hunting in
    // the wrong Settings pane for whichever one they hit.
    expect(new Set(reasons).size).toBe(FEATURES.length);
  });

  it('never claims a restriction in a standard build', () => {
    const policy = resolveDistributionProfile({});
    for (const feature of FEATURES) {
      expect(policy.refusalReason(feature)).toContain('available in this build');
    }
  });
});
