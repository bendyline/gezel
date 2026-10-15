/**
 * Connect codes for remote serving, the server half: the 8-digit code this
 * device shows under Settings → Remote Servers → Add a device, and the
 * SPAKE2 runs (see spake2.ts) that let a client prove it typed that code.
 *
 * A code is a live secret, so it exists only on request and briefly: opening
 * one replaces any previous one, it expires after five minutes, it pairs
 * exactly one device, and each protocol run spends one of five attempts
 * whether it succeeds or not — starting a run is what lets a peer test one
 * guess, so that is where it is counted. Nothing here touches disk; a
 * restart closes the window.
 */

import { randomInt, randomUUID } from 'node:crypto';
import {
  Spake2Error,
  confirmationsMatch,
  passwordScalar,
  spake2Finish,
  spake2Start,
} from './spake2.js';

/** Domain separation for the password scalar and the SPAKE2 AAD. */
export const PAIRING_PROTOCOL = 'gezel remote pairing v1';
export const PAIRING_CODE_DIGITS = 8;

const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_SESSION_TTL_MS = 60_000;

/** `48210937`, `4821 0937`, and `4821-0937` are the same code; anything else is not one. */
export function normalizePairingCode(input: string): string | null {
  const digits = input.replace(/[\s-]/g, '');
  return new RegExp(`^\\d{${PAIRING_CODE_DIGITS}}$`).test(digits) ? digits : null;
}

export function pairingPasswordScalar(code: string): bigint {
  return passwordScalar(code, PAIRING_PROTOCOL);
}

export interface PairingCodeView {
  code: string;
  expiresAt: number;
  attemptsLeft: number;
}

/** Who is asking to pair. `fingerprint` is derived from the identity key the client sent. */
export interface PairingClient {
  appId: string;
  appName: string;
  fingerprint: string;
}

export class PairingClosedError extends Error {
  constructor() {
    super('No connect code is showing on this device');
    this.name = 'PairingClosedError';
  }
}

export class PairingAttemptsExhaustedError extends Error {
  constructor() {
    super('Too many attempts with this connect code');
    this.name = 'PairingAttemptsExhaustedError';
  }
}

/** The client's confirmation did not check out: a wrong code, or not the device that started. */
export class PairingRejectedError extends Error {
  constructor() {
    super('The connect code did not match');
    this.name = 'PairingRejectedError';
  }
}

export class PairingShareInvalidError extends Error {
  constructor() {
    super('The pairing message was not valid');
    this.name = 'PairingShareInvalidError';
  }
}

export interface PairingCodes {
  /** Shows a fresh code, replacing any previous one. */
  open(): PairingCodeView;
  current(): PairingCodeView | null;
  close(): void;
  /** The device the last code paired, for the UI's "connected" note. */
  lastPaired(): { appName: string; at: number } | null;
  /** SPAKE2 round one for a client's share. Spends one attempt. */
  begin(input: { share: Buffer; client: PairingClient }): { sessionId: string; share: Buffer };
  /**
   * SPAKE2 round two. Returns this side's confirmation when the client's
   * checks out, and closes the window: one code, one device.
   */
  confirm(sessionId: string, confirmA: Buffer): { confirmB: Buffer; client: PairingClient };
}

interface Window {
  generation: number;
  code: string;
  w: bigint;
  expiresAt: number;
  attemptsLeft: number;
}

interface Session {
  generation: number;
  expiresAt: number;
  confirmA: Buffer;
  confirmB: Buffer;
  client: PairingClient;
}

export function createPairingCodes(opts: {
  /** This server's identity fingerprint; null → it cannot pair at all. */
  serverFingerprint: () => string | null;
  ttlMs?: number;
  maxAttempts?: number;
  sessionTtlMs?: number;
  now?: () => number;
}): PairingCodes {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const sessionTtlMs = opts.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  const now = opts.now ?? Date.now;
  let window: Window | null = null;
  let generation = 0;
  let paired: { appName: string; at: number } | null = null;
  const sessions = new Map<string, Session>();

  // Expiry stops new runs only. A run started just before it may still
  // finish; closing, reopening, or pairing is what ends runs in flight.
  const live = (): Window | null => (window && window.expiresAt > now() ? window : null);

  const close = () => {
    window = null;
    sessions.clear();
  };

  const view = (w: Window): PairingCodeView => ({
    code: w.code,
    expiresAt: w.expiresAt,
    attemptsLeft: w.attemptsLeft,
  });

  return {
    open() {
      close();
      const code = String(randomInt(0, 10 ** PAIRING_CODE_DIGITS)).padStart(
        PAIRING_CODE_DIGITS,
        '0',
      );
      generation += 1;
      window = {
        generation,
        code,
        w: pairingPasswordScalar(code),
        expiresAt: now() + ttlMs,
        attemptsLeft: maxAttempts,
      };
      return view(window);
    },

    current() {
      const w = live();
      return w ? view(w) : null;
    },

    close,

    lastPaired: () => paired,

    begin(input) {
      const w = live();
      if (!w) throw new PairingClosedError();
      if (w.attemptsLeft <= 0) {
        close();
        throw new PairingAttemptsExhaustedError();
      }
      const serverFingerprint = opts.serverFingerprint();
      if (!serverFingerprint) throw new PairingClosedError();
      w.attemptsLeft -= 1;
      const state = spake2Start('B', w.w);
      let keys: ReturnType<typeof spake2Finish>;
      try {
        keys = spake2Finish(state, {
          idA: input.client.fingerprint,
          idB: serverFingerprint,
          peerShare: input.share,
          aad: PAIRING_PROTOCOL,
        });
      } catch (err) {
        if (err instanceof Spake2Error) throw new PairingShareInvalidError();
        throw err;
      }
      const sessionId = randomUUID();
      sessions.set(sessionId, {
        generation: w.generation,
        expiresAt: now() + sessionTtlMs,
        confirmA: keys.confirmA,
        confirmB: keys.confirmB,
        client: input.client,
      });
      return { sessionId, share: state.share };
    },

    confirm(sessionId, confirmA) {
      const session = sessions.get(sessionId);
      sessions.delete(sessionId);
      if (
        !session ||
        session.expiresAt <= now() ||
        window?.generation !== session.generation ||
        !confirmationsMatch(session.confirmA, confirmA)
      ) {
        throw new PairingRejectedError();
      }
      paired = { appName: session.client.appName, at: now() };
      close();
      return { confirmB: session.confirmB, client: session.client };
    },
  };
}
