import { describe, expect, it } from 'vitest';
import {
  PAIRING_PROTOCOL,
  PairingAttemptsExhaustedError,
  PairingClosedError,
  PairingRejectedError,
  PairingShareInvalidError,
  createPairingCodes,
  normalizePairingCode,
  pairingPasswordScalar,
} from './pairing-code.js';
import { confirmationsMatch, spake2Finish, spake2Start } from './spake2.js';

const SERVER_FP = 'b'.repeat(64);
const CLIENT = { appId: 'laptop-1', appName: 'Laptop', fingerprint: 'c'.repeat(64) };

/** The client's half of a run, as pairRemoteWithCode does it. */
function clientRun(codes: ReturnType<typeof createPairingCodes>, typed: string) {
  const state = spake2Start('A', pairingPasswordScalar(typed));
  const started = codes.begin({ share: state.share, client: CLIENT });
  const keys = spake2Finish(state, {
    idA: CLIENT.fingerprint,
    idB: SERVER_FP,
    peerShare: started.share,
    aad: PAIRING_PROTOCOL,
  });
  return { sessionId: started.sessionId, keys };
}

describe('normalizePairingCode', () => {
  it('accepts eight digits with spaces or a dash, and nothing else', () => {
    expect(normalizePairingCode('48210937')).toBe('48210937');
    expect(normalizePairingCode(' 4821 0937 ')).toBe('48210937');
    expect(normalizePairingCode('4821-0937')).toBe('48210937');
    expect(normalizePairingCode('4821093')).toBeNull();
    expect(normalizePairingCode('4821093a')).toBeNull();
  });
});

describe('createPairingCodes', () => {
  it('shows an 8-digit code only after it is opened, and replaces it on reopen', () => {
    const codes = createPairingCodes({ serverFingerprint: () => SERVER_FP });
    expect(codes.current()).toBeNull();
    const first = codes.open();
    expect(first.code).toMatch(/^\d{8}$/);
    expect(first.attemptsLeft).toBe(5);
    const second = codes.open();
    expect(codes.current()).toEqual(second);
    codes.close();
    expect(codes.current()).toBeNull();
  });

  it('pairs the device that typed the code, then closes: one code, one device', () => {
    const codes = createPairingCodes({ serverFingerprint: () => SERVER_FP });
    const { code } = codes.open();
    const run = clientRun(codes, code);
    const result = codes.confirm(run.sessionId, run.keys.confirmA);
    expect(confirmationsMatch(result.confirmB, run.keys.confirmB)).toBe(true);
    expect(result.client).toEqual(CLIENT);
    expect(codes.current()).toBeNull();
    expect(codes.lastPaired()).toMatchObject({ appName: 'Laptop' });
    expect(() => codes.begin({ share: Buffer.alloc(65), client: CLIENT })).toThrow(
      PairingClosedError,
    );
  });

  it('rejects a wrong code, spends an attempt, and keeps the code open', () => {
    const codes = createPairingCodes({ serverFingerprint: () => SERVER_FP });
    const { code } = codes.open();
    const wrong = code === '00000000' ? '00000001' : '00000000';
    const run = clientRun(codes, wrong);
    expect(() => codes.confirm(run.sessionId, run.keys.confirmA)).toThrow(PairingRejectedError);
    expect(codes.current()?.attemptsLeft).toBe(4);
    // The real code still works afterwards.
    const retry = clientRun(codes, code);
    expect(() => codes.confirm(retry.sessionId, retry.keys.confirmA)).not.toThrow();
  });

  it('a session is good for one confirmation', () => {
    const codes = createPairingCodes({ serverFingerprint: () => SERVER_FP });
    const { code } = codes.open();
    const wrong = code === '00000000' ? '00000001' : '00000000';
    const run = clientRun(codes, wrong);
    expect(() => codes.confirm(run.sessionId, run.keys.confirmA)).toThrow(PairingRejectedError);
    expect(() => codes.confirm(run.sessionId, run.keys.confirmA)).toThrow(PairingRejectedError);
  });

  it('closes after its attempts run out, even if the next guess would be right', () => {
    const codes = createPairingCodes({ serverFingerprint: () => SERVER_FP, maxAttempts: 2 });
    const { code } = codes.open();
    const wrong = code === '00000000' ? '00000001' : '00000000';
    clientRun(codes, wrong);
    clientRun(codes, wrong);
    expect(() => clientRun(codes, code)).toThrow(PairingAttemptsExhaustedError);
    expect(codes.current()).toBeNull();
  });

  it('stops new runs at expiry but lets a run already started finish', () => {
    let now = 1_000;
    const codes = createPairingCodes({
      serverFingerprint: () => SERVER_FP,
      ttlMs: 1_000,
      now: () => now,
    });
    const { code } = codes.open();
    const run = clientRun(codes, code);
    now += 1_500;
    expect(codes.current()).toBeNull();
    expect(() => clientRun(codes, code)).toThrow(PairingClosedError);
    expect(() => codes.confirm(run.sessionId, run.keys.confirmA)).not.toThrow();
  });

  it('withdrawing the code ends runs in flight', () => {
    const codes = createPairingCodes({ serverFingerprint: () => SERVER_FP });
    const { code } = codes.open();
    const run = clientRun(codes, code);
    codes.close();
    expect(() => codes.confirm(run.sessionId, run.keys.confirmA)).toThrow(PairingRejectedError);
  });

  it('refuses a share that is not a P-256 point, and counts it as an attempt', () => {
    const codes = createPairingCodes({ serverFingerprint: () => SERVER_FP });
    codes.open();
    expect(() => codes.begin({ share: Buffer.from([4, 1, 2, 3]), client: CLIENT })).toThrow(
      PairingShareInvalidError,
    );
    expect(codes.current()?.attemptsLeft).toBe(4);
  });
});
