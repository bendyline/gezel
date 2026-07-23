import { describe, expect, it } from 'vitest';
import { blindDigits, detectTriageCluster, trialSignature } from './trial-signature.ts';
import type { TrialResult } from './types.ts';

const result = (overrides: Partial<TrialResult> = {}): TrialResult => ({
  trialId: 'trial-0',
  scenarioId: 'bookstore-openapi',
  modelId: 'gemma4-e4b-q8',
  startedAt: '2026-07-08T00:00:00.000Z',
  finishedAt: '2026-07-08T00:01:00.000Z',
  durationMs: 60_000,
  success: false,
  reason: 'no real progress',
  failureMode: 'no-progress',
  failureClass: 'model',
  failureClassRule: 'model-default',
  finalSniff: {
    key: 'openapi.yaml:sniff',
    score: 3,
    bytes: 900,
    failReason: 'ErrorEnvelope missing',
  },
  runDir: '',
  ...overrides,
});

describe('blindDigits', () => {
  it('collapses unit-tagged numeric churn to a stable form', () => {
    expect(blindDigits('inline JS is only 342 bytes')).toBe('inline js is only # bytes');
    expect(blindDigits('inline JS is only 342 bytes')).toBe(
      blindDigits('inline JS is only 1204 bytes'),
    );
  });

  it('collapses bare numbers and time fragments', () => {
    expect(blindDigits('stalled at 04:03')).toBe(blindDigits('stalled at 04:57'));
    expect(blindDigits('reached 5/7 checks')).toBe(blindDigits('reached 6/7 checks'));
  });

  it('keeps distinct wording distinct', () => {
    expect(blindDigits('missing grid')).not.toBe(blindDigits('missing click handler'));
  });
});

describe('trialSignature', () => {
  it('returns null for a pass (nothing to triage)', () => {
    expect(trialSignature(result({ success: true }))).toBeNull();
  });

  it('returns null for operator interrupts (a human Ctrl-C is not a cell defect)', () => {
    expect(
      trialSignature(result({ failureClass: 'operator', failureClassRule: 'operator-interrupt' })),
    ).toBeNull();
    expect(trialSignature(result({ failureMode: 'interrupted' }))).toBeNull();
  });

  it('uses the classifier rule directly when it is already discriminating', () => {
    expect(trialSignature(result({ failureClass: 'infra', failureClassRule: 'spawn-error' }))).toBe(
      'infra/spawn-error',
    );
    expect(
      trialSignature(result({ failureClass: 'infra', failureClassRule: 'capacity-denial' })),
    ).toBe('infra/capacity-denial');
  });

  it('refines the undifferentiated model-default with sniff identity', () => {
    const sig = trialSignature(result());
    expect(sig).toBe('model/model-default#openapi.yaml:sniff#errorenvelope missing');
  });

  it('clusters byte-churn on the same defect (digit-blinded reason)', () => {
    const a = trialSignature(
      result({
        finalSniff: {
          key: 'index.html:sniff',
          score: 3,
          bytes: 340,
          failReason: 'inline JS is only 340 bytes',
        },
      }),
    );
    const b = trialSignature(
      result({
        finalSniff: {
          key: 'index.html:sniff',
          score: 4,
          bytes: 511,
          failReason: 'inline JS is only 511 bytes',
        },
      }),
    );
    expect(a).toBe(b);
  });

  it('separates distinct model misses (different sniff key or reason)', () => {
    const missGrid = trialSignature(
      result({
        finalSniff: { key: 'index.html:sniff', score: 3, bytes: 900, failReason: 'missing grid' },
      }),
    );
    const missClick = trialSignature(
      result({
        finalSniff: {
          key: 'index.html:sniff',
          score: 3,
          bytes: 900,
          failReason: 'missing click handler',
        },
      }),
    );
    expect(missGrid).not.toBe(missClick);
  });

  it('falls back to no-sniff for a bare pre-sniff model death', () => {
    expect(trialSignature(result({ finalSniff: undefined }))).toBe('model/model-default#no-sniff#');
  });
});

describe('detectTriageCluster', () => {
  const fail = (i: number, o: Partial<TrialResult> = {}) => result({ trialId: `t${i}`, ...o });

  it('finds the first maximal run of identical signatures >= k', () => {
    const cluster = detectTriageCluster([fail(0), fail(1), fail(2), fail(3)], 3, {
      stopped: true,
      requestedCount: 5,
    });
    expect(cluster).not.toBeNull();
    expect(cluster!.count).toBe(4);
    expect(cluster!.stopped).toBe(true);
    expect(cluster!.skipped).toBe(1); // requested 5, ran 4
    expect(cluster!.trialIds).toEqual(['t0', 't1', 't2', 't3']);
    expect(cluster!.representativeReason).toBe('no real progress');
  });

  it('returns null when no run reaches k', () => {
    const alt = [
      fail(0, { finalSniff: { key: 'a', score: 3, bytes: 1, failReason: 'x' } }),
      fail(1, { finalSniff: { key: 'b', score: 3, bytes: 1, failReason: 'y' } }),
      fail(2, { finalSniff: { key: 'a', score: 3, bytes: 1, failReason: 'x' } }),
    ];
    expect(detectTriageCluster(alt, 3, { stopped: false, requestedCount: 3 })).toBeNull();
  });

  it('a pass in the middle breaks the run', () => {
    const seq = [fail(0), fail(1), result({ trialId: 't2', success: true }), fail(3), fail(4)];
    expect(detectTriageCluster(seq, 3, { stopped: false, requestedCount: 5 })).toBeNull();
  });

  it('reports skipped=0 when not stopped (parallel>1 reporting)', () => {
    const cluster = detectTriageCluster([fail(0), fail(1), fail(2)], 3, {
      stopped: false,
      requestedCount: 6,
    });
    expect(cluster!.stopped).toBe(false);
    expect(cluster!.skipped).toBe(0);
  });

  it('k<=0 disables detection', () => {
    expect(
      detectTriageCluster([fail(0), fail(1), fail(2)], 0, { stopped: false, requestedCount: 3 }),
    ).toBeNull();
  });
});
