import { describe, expect, it } from 'vitest';
import {
  type PreflightEvidence,
  buildPreflightChecks,
  isReusablePassingPreflightReport,
  preflightPolicyFingerprint,
} from './preflight.ts';

function evidence(overrides: Partial<PreflightEvidence>): PreflightEvidence {
  return {
    result: { success: true, reason: 'tool round-trip OK: preflight.txt written' },
    daemonLog: 'tuning gezel=probe profile=thinking-general kind=thinking temp=0.8',
    genTokensPerSec: 25,
    manifestHasProfiles: true,
    minGenTokensPerSec: 3,
    ...overrides,
  };
}

describe('buildPreflightChecks', () => {
  it('a healthy probe is admitted on all five checks', () => {
    const { checks, admitted } = buildPreflightChecks(evidence({}));
    expect(admitted).toBe(true);
    for (const c of Object.values(checks)) expect(c.ok).toBe(true);
  });

  it('capacity denial in the log fails spawn', () => {
    const { checks, admitted } = buildPreflightChecks(
      evidence({
        result: { success: false, reason: 'chat stalled for 302s', failureMode: 'chat-stalled' },
        daemonLog:
          'ERROR capacity broker denied llama-cpp:big-model:0: budget exhausted: would commit 103261295501 against 78357907046',
      }),
    );
    expect(admitted).toBe(false);
    expect(checks.spawn.ok).toBe(false);
    expect(checks.spawn.detail).toContain('capacity broker denied');
  });

  it('a failed probe trial fails the tool round-trip check', () => {
    const { checks, admitted } = buildPreflightChecks(
      evidence({
        result: {
          success: false,
          reason: 'retry loop (long-path): sniff "preflight:0:0" stuck for 12m',
          failureMode: 'model-stuck',
        },
      }),
    );
    expect(admitted).toBe(false);
    expect(checks.toolRoundTrip.ok).toBe(false);
  });

  it('profile fall-through fails when the manifest authors profiles', () => {
    const { checks, admitted } = buildPreflightChecks(
      evidence({
        daemonLog: 'tuning gezel=probe profile=none(req=thinking-general@gezel) kind=n/a temp=?',
      }),
    );
    expect(admitted).toBe(false);
    expect(checks.profileResolution.ok).toBe(false);
    expect(checks.profileResolution.detail).toContain('fell through');
  });

  it('profile fall-through is non-gating when the manifest has no profiles', () => {
    const { checks, admitted } = buildPreflightChecks(
      evidence({
        daemonLog: 'tuning gezel=probe profile=none(req=thinking-general@suggested) kind=n/a',
        manifestHasProfiles: false,
      }),
    );
    expect(admitted).toBe(true);
    expect(checks.profileResolution.ok).toBe(true);
    expect(checks.profileResolution.detail).toContain('expected fall-through');
  });

  it('unbounded reasoning budget fails (the deepseek-r1 sentinel)', () => {
    const { checks, admitted } = buildPreflightChecks(
      evidence({
        daemonLog:
          'tuning gezel=probe profile=thinking-general kind=thinking\n' +
          '[llama-cpp] reasoning-budget: activated, budget=2147483647',
      }),
    );
    expect(admitted).toBe(false);
    expect(checks.reasoningBudget.ok).toBe(false);
  });

  it('a bounded reasoning budget passes', () => {
    const { checks } = buildPreflightChecks(
      evidence({
        daemonLog:
          'tuning gezel=probe profile=thinking-general kind=thinking\n' +
          '[llama-cpp] reasoning-budget: activated, budget=512 ... budget exhausted, forcing end sequence',
      }),
    );
    expect(checks.reasoningBudget.ok).toBe(true);
    expect(checks.reasoningBudget.detail).toContain('budget=512');
  });

  it('throughput below the floor fails (the mistral-medium class)', () => {
    const { checks, admitted } = buildPreflightChecks(evidence({ genTokensPerSec: 1.2 }));
    expect(admitted).toBe(false);
    expect(checks.throughput.ok).toBe(false);
  });

  it('unmeasured throughput is non-gating', () => {
    const { checks, admitted } = buildPreflightChecks(evidence({ genTokensPerSec: null }));
    expect(admitted).toBe(true);
    expect(checks.throughput.detail).toContain('not measured');
  });

  it('missing daemon log degrades gracefully (reason-only verdicts)', () => {
    const { checks, admitted } = buildPreflightChecks(evidence({ daemonLog: null }));
    expect(admitted).toBe(true);
    expect(checks.profileResolution.detail).toContain('no tuning trace');
  });
});

describe('preflight admission cache policy', () => {
  const now = Date.parse('2026-07-10T12:00:00.000Z');

  it('reuses a recent passing report only when the policy fingerprint matches', () => {
    expect(
      isReusablePassingPreflightReport(
        {
          admitted: true,
          policyFingerprint: 'policy-a',
          createdAt: new Date(now - 60_000).toISOString(),
        },
        'policy-a',
        now,
      ),
    ).toBe(true);
  });

  it('rejects a policy mismatch and legacy reports with no fingerprint', () => {
    const recentPass = {
      admitted: true,
      createdAt: new Date(now - 60_000).toISOString(),
    };
    expect(
      isReusablePassingPreflightReport(
        { ...recentPass, policyFingerprint: 'old-policy' },
        'new-policy',
        now,
      ),
    ).toBe(false);
    expect(isReusablePassingPreflightReport(recentPass, 'new-policy', now)).toBe(false);
  });

  it('fingerprints effective thresholds and binary overrides', () => {
    const base = {
      modelId: 'qwen3.5-122b-a10b-q4',
      engine: 'llama-cpp' as const,
      llamaBin: '/tmp/gezel-llama-a',
      minGenTokensPerSec: 3,
    };
    expect(preflightPolicyFingerprint(base)).toBe(preflightPolicyFingerprint({ ...base }));
    expect(preflightPolicyFingerprint({ ...base, minGenTokensPerSec: 4 })).not.toBe(
      preflightPolicyFingerprint(base),
    );
    expect(preflightPolicyFingerprint({ ...base, llamaBin: '/tmp/gezel-llama-b' })).not.toBe(
      preflightPolicyFingerprint(base),
    );
  });
});
