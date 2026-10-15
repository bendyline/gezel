/**
 * Connect codes for remote serving, the server half: the 8-digit code this
 * device shows under Settings → Remote Servers → Add a device, and the
 * SPAKE2 runs (core's `remote/spake2.ts`, shared with every client) that let
 * a client prove it typed that code.
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
  PAIRING_CODE_DIGITS,
  PAIRING_PROTOCOL,
  Spake2Error,
  confirmationsMatch,
  pairingPasswordScalar,
  spake2Finish,
  spake2Start,
} from '@bendyline/gezel/remote';

export {
  PAIRING_CODE_DIGITS,
  PAIRING_PROTOCOL,
  normalizePairingCode,
  pairingPasswordScalar,
} from '@bendyline/gezel/remote';

const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_SESSION_TTL_MS = 60_000;

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
  begin(input: {
    share: Uint8Array;
    client: PairingClient;
  }): Promise<{ sessionId: string; share: Uint8Array }>;
  /**
   * SPAKE2 round two. Returns this side's confirmation when the client's
   * checks out, and closes the window: one code, one device.
   */
  confirm(
    sessionId: string,
    confirmA: Uint8Array,
  ): { confirmB: Uint8Array; client: PairingClient };
}

interface Window {
  generation: number;
  code: string;
  /** The SPAKE2 password scalar, derived on the first attempt and kept. */
  w?: Promise<bigint>;
  expiresAt: number;
  attemptsLeft: number;
}

interface Session {
  generation: number;
  expiresAt: number;
  confirmA: Uint8Array;
  confirmB: Uint8Array;
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
      window = { generation, code, expiresAt: now() + ttlMs, attemptsLeft: maxAttempts };
      return view(window);
    },

    current() {
      const w = live();
      return w ? view(w) : null;
    },

    close,

    lastPaired: () => paired,

    async begin(input) {
      const w = live();
      if (!w) throw new PairingClosedError();
      if (w.attemptsLeft <= 0) {
        close();
        throw new PairingAttemptsExhaustedError();
      }
      const serverFingerprint = opts.serverFingerprint();
      if (!serverFingerprint) throw new PairingClosedError();
      // Spent before anything is awaited, so concurrent runs can't share one.
      w.attemptsLeft -= 1;
      w.w ??= pairingPasswordScalar(w.code);
      const state = spake2Start('B', await w.w);
      let keys: Awaited<ReturnType<typeof spake2Finish>>;
      try {
        keys = await spake2Finish(state, {
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
