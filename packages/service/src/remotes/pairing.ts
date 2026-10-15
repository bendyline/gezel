/**
 * pairRemote — Device A pairing with a server (Device B) for remote model
 * execution. Reuses the `/v1/apps/register` consent flow (a paired device is
 * just a `kind:'device'` app grant) and adds the device-identity handshake:
 *
 *   1. TOFU-bootstrap GET `B/v1/identity` → B's identity pubkey + TLS cert + a
 *      signature proving B holds the identity private key.
 *   2. Self-verify the identity (fingerprint↔pubkey, sig over cert fingerprint),
 *      then pin B's cert and build a pinned fetch.
 *   3. POST `/v1/apps/register` as `appId=<A.deviceId>`, scope
 *      `remote-inference`, carrying A's identity pubkey; poll until the user on
 *      B approves; capture the issued token.
 *   4. Persist a {@link PairedRemote} (token + pinned identity) to A's registry.
 *
 * On a later re-pair where B's identity fingerprint changed, the caller must
 * confirm (SSH "host identity changed") before overwriting the pin.
 */

import { isIP } from 'node:net';
import { createLogger } from '@bendyline/gezel';
import {
  IdentityResponseSchema,
  certFingerprintFromPem,
  fingerprintOfPublicKeyPem,
  verifyIdentitySignature,
} from '@bendyline/gezel-inference/internal/remotes/identity';
import {
  createInsecureBootstrapFetch,
  createPinnedFetch,
} from '@bendyline/gezel-inference/internal/remotes/pinned-fetch';
import type { ServiceContext } from '../http/context.js';
import { displayHostname } from './lan-discovery.js';
import { PAIRING_PROTOCOL, normalizePairingCode, pairingPasswordScalar } from './pairing-code.js';
import type { PairedRemote } from './registry.js';
import { Spake2Error, confirmationsMatch, spake2Finish, spake2Start } from './spake2.js';

const log = createLogger('remote-pairing');

export interface PairRemoteInput {
  /** B's base URL, e.g. `https://192.168.1.50:6229`. */
  baseUrl: string;
  /**
   * What A calls B. Never sent to B: B's approval prompt names A by A's own
   * hostname, so a label typed (or discovered) for the server can't make a
   * pairing request look like it came from the server itself.
   */
  displayName?: string;
  approvalTimeoutSec?: number;
  /** Fingerprint the user verified out-of-band during the inspect step. */
  expectedIdentityFingerprint: string;
  /**
   * When B's identity fingerprint differs from an existing pin for the same
   * server, pairing refuses unless this is set (the user confirmed the change
   * in the UI). Mirrors SSH's REMOTE HOST IDENTIFICATION HAS CHANGED gate.
   */
  acceptIdentityChange?: boolean;
}

export class IdentityChangedError extends Error {
  constructor(
    readonly remoteId: string,
    readonly oldFingerprint: string,
    readonly newFingerprint: string,
  ) {
    super(
      `The server's identity changed (pinned ${oldFingerprint.slice(0, 16)}…, now ${newFingerprint.slice(0, 16)}…). Re-pair only if you trust this change.`,
    );
    this.name = 'IdentityChangedError';
  }
}

/** Stable collision-resistant id A assigns to a server. */
export function remoteIdForFingerprint(fingerprint: string): string {
  return fingerprint;
}

/** Remote pairing is permitted only to one exact HTTPS origin. */
export function normalizeRemoteBaseUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error('pairing: remote URL is invalid');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('pairing: remote URL must be an exact HTTPS origin');
  }
  // The serving side's host guard admits only IP-literal authorities (DNS
  // names stay forbidden so DNS rebinding cannot mint authority), so a
  // DNS-name origin used to pair successfully and then 403 on every later
  // request. Reject it here, at inspect time, with the fix in hand.
  // mDNS/.local support needs an exact-allowlist design on the server first.
  const bareHost = url.hostname.replace(/^\[/, '').replace(/\]$/, '');
  if (isIP(bareHost) === 0) {
    throw new Error(
      "pairing: use the server's IP address (e.g. https://192.168.1.50:6229) — " +
        'names are rejected because the serving side only answers requests addressed to an IP literal',
    );
  }
  return url.origin;
}

export function remoteBaseUrlMatches(input: string, expectedOrigin: string): boolean {
  try {
    return normalizeRemoteBaseUrl(input) === expectedOrigin;
  } catch {
    return false;
  }
}

export async function inspectRemoteIdentity(baseUrlInput: string, fetchIdentity?: typeof fetch) {
  const baseUrl = normalizeRemoteBaseUrl(baseUrlInput);
  const ownedFetch = fetchIdentity ? null : createInsecureBootstrapFetch();
  const identityFetch = fetchIdentity ?? ownedFetch!;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error('remote identity request timed out')),
    10_000,
  );
  timeout.unref?.();
  try {
    const response = await identityFetch(`${baseUrl}/v1/identity`, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`pairing: GET /v1/identity returned HTTP ${response.status}`);
    }
    const identity = IdentityResponseSchema.parse(await response.json());
    verifyRemoteIdentity(identity);
    return identity;
  } finally {
    clearTimeout(timeout);
    await ownedFetch?.close();
  }
}

export async function pairRemote(
  ctx: ServiceContext,
  input: PairRemoteInput,
): Promise<PairedRemote> {
  const baseUrl = normalizeRemoteBaseUrl(input.baseUrl);
  // B pins the identity we present; a service without one cannot pair.
  const ownIdentity = ctx.deviceIdentity;
  if (!ownIdentity) {
    throw new Error('pairing: this service has no device identity to pair with');
  }

  // 1. TOFU bootstrap — fetch B's identity over an unpinned HTTPS connection.
  const identity = await inspectRemoteIdentity(baseUrl);
  if (identity.fingerprint !== input.expectedIdentityFingerprint) {
    throw new Error('pairing: the server identity no longer matches the fingerprint you confirmed');
  }

  const remoteId = remoteIdForFingerprint(identity.fingerprint);
  const existing = ctx.remotes
    .list()
    .find((remote) => remoteBaseUrlMatches(remote.baseUrl, baseUrl));
  if (
    existing &&
    existing.pinnedIdentityFingerprint !== identity.fingerprint &&
    !input.acceptIdentityChange
  ) {
    throw new IdentityChangedError(
      remoteId,
      existing.pinnedIdentityFingerprint,
      identity.fingerprint,
    );
  }

  // 3. Pin B's cert and register over the pinned channel.
  const pinned = createPinnedFetch(identity.tlsCertPem!);
  let token: string;
  try {
    token = await registerAndPoll({
      baseUrl,
      fetch: pinned,
      appId: ownIdentity.deviceId,
      appName: displayHostname(),
      deviceIdentityPubKey: ownIdentity.publicKeyPem,
      timeoutMs: (input.approvalTimeoutSec ?? 120) * 1000,
    });
  } finally {
    await pinned.close();
  }

  // 4. Persist.
  const paired: PairedRemote = {
    remoteId,
    baseUrl,
    displayName: input.displayName?.trim() || new URL(baseUrl).hostname,
    token,
    pinnedIdentityKey: identity.publicKeyPem,
    pinnedIdentityFingerprint: identity.fingerprint,
    tlsCertPem: identity.tlsCertPem,
    scopes: ['remote-inference'],
    pairedAt: Date.now(),
  };
  await ctx.remotes.add(paired);
  log.info(`[remote-pairing] paired with ${baseUrl} as ${remoteId} (${paired.displayName})`);
  return paired;
}

/** The server is not showing a connect code (or it expired, or another device used it). */
export class PairingCodeClosedError extends Error {
  constructor() {
    super(
      "That device isn't showing a connect code. On it, open Settings → Remote Servers and choose Add a device.",
    );
    this.name = 'PairingCodeClosedError';
  }
}

/** Wrong code, or a device in the middle that could not prove it knew the code. */
export class PairingCodeRejectedError extends Error {
  constructor() {
    super("That code doesn't match. Check the code on the other device and try again.");
    this.name = 'PairingCodeRejectedError';
  }
}

export class PairingCodeAttemptsError extends Error {
  constructor() {
    super('Too many wrong codes. On the other device, choose Add a device again for a new code.');
    this.name = 'PairingCodeAttemptsError';
  }
}

/** The server predates connect codes; pair with the approval flow instead. */
export class PairingCodeUnsupportedError extends Error {
  constructor() {
    super("That device's gezel is too old for connect codes.");
    this.name = 'PairingCodeUnsupportedError';
  }
}

export interface PairWithCodeInput {
  baseUrl: string;
  /** The 8 digits shown on B, spaces and dashes allowed. */
  code: string;
  /** What A calls B; defaults to the name B reports once the code checks out. */
  displayName?: string;
}

async function postJson(
  fetchImpl: typeof fetch,
  url: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, json };
}

/**
 * Pairing with a connect code: A runs SPAKE2 (see spake2.ts) with B over a
 * channel pinned to the TLS cert B's identity signed. Both fingerprints are
 * in the transcript, so a run that confirms proves B is the device showing
 * the code the person typed — which is why, unlike {@link pairRemote}, this
 * needs no identity-code comparison and re-pins a changed identity without
 * asking: the code is the out-of-band check. B issues the token only after
 * A's confirmation checks out, and A keeps it only after B's does.
 */
export async function pairRemoteWithCode(
  ctx: ServiceContext,
  input: PairWithCodeInput,
): Promise<PairedRemote> {
  const baseUrl = normalizeRemoteBaseUrl(input.baseUrl);
  const ownIdentity = ctx.deviceIdentity;
  if (!ownIdentity) {
    throw new Error('pairing: this service has no device identity to pair with');
  }
  const code = normalizePairingCode(input.code);
  if (!code) throw new PairingCodeRejectedError();

  const identity = await inspectRemoteIdentity(baseUrl);
  if (!identity.pairingMethods?.includes('code')) throw new PairingCodeUnsupportedError();

  const pinned = createPinnedFetch(identity.tlsCertPem!);
  let token: string;
  let reportedName: string | undefined;
  try {
    const state = spake2Start('A', pairingPasswordScalar(code));
    const start = await postJson(pinned, `${baseUrl}/v1/apps/pair/start`, {
      appId: ownIdentity.deviceId,
      appName: displayHostname(),
      deviceIdentityPubKey: ownIdentity.publicKeyPem,
      share: state.share.toString('base64'),
    });
    if (start.status === 409) throw new PairingCodeClosedError();
    if (start.status === 429) throw new PairingCodeAttemptsError();
    if (start.status === 404) throw new PairingCodeUnsupportedError();
    if (start.status !== 200 || typeof start.json.sessionId !== 'string') {
      throw new Error(`pairing: start returned HTTP ${start.status}`);
    }
    let keys: ReturnType<typeof spake2Finish>;
    try {
      keys = spake2Finish(state, {
        idA: ownIdentity.fingerprint,
        idB: identity.fingerprint,
        peerShare: Buffer.from(String(start.json.share ?? ''), 'base64'),
        aad: PAIRING_PROTOCOL,
      });
    } catch (err) {
      if (err instanceof Spake2Error) throw new PairingCodeRejectedError();
      throw err;
    }
    const finish = await postJson(pinned, `${baseUrl}/v1/apps/pair/finish`, {
      sessionId: start.json.sessionId,
      confirm: keys.confirmA.toString('base64'),
    });
    if (finish.status === 403) throw new PairingCodeRejectedError();
    if (finish.status !== 200 || typeof finish.json.token !== 'string') {
      throw new Error(`pairing: finish returned HTTP ${finish.status}`);
    }
    if (
      !confirmationsMatch(keys.confirmB, Buffer.from(String(finish.json.confirm ?? ''), 'base64'))
    ) {
      throw new PairingCodeRejectedError();
    }
    token = finish.json.token;
    if (typeof finish.json.name === 'string') reportedName = finish.json.name.trim().slice(0, 120);
  } finally {
    await pinned.close();
  }

  const paired: PairedRemote = {
    remoteId: remoteIdForFingerprint(identity.fingerprint),
    baseUrl,
    displayName: input.displayName?.trim() || reportedName || new URL(baseUrl).hostname,
    token,
    pinnedIdentityKey: identity.publicKeyPem,
    pinnedIdentityFingerprint: identity.fingerprint,
    tlsCertPem: identity.tlsCertPem,
    scopes: ['remote-inference'],
    pairedAt: Date.now(),
  };
  // A device re-paired after a reinstall has a new identity at the same
  // address; the registry drops the stale entry for that address.
  await ctx.remotes.add(paired);
  log.info(`[remote-pairing] paired with ${baseUrl} by connect code (${paired.displayName})`);
  return paired;
}

function verifyRemoteIdentity(identity: ReturnType<typeof IdentityResponseSchema.parse>): void {
  if (fingerprintOfPublicKeyPem(identity.publicKeyPem) !== identity.fingerprint) {
    throw new Error('pairing: identity fingerprint does not match its public key');
  }
  if (!identity.tlsCertPem || !identity.sig || !identity.tlsCertFingerprint) {
    throw new Error('pairing: remote serving requires a signed TLS certificate identity');
  }
  if (certFingerprintFromPem(identity.tlsCertPem) !== identity.tlsCertFingerprint) {
    throw new Error('pairing: signed TLS cert fingerprint does not match the returned cert');
  }
  if (!verifyIdentitySignature(identity.publicKeyPem, identity.tlsCertFingerprint, identity.sig)) {
    throw new Error('pairing: identity signature over the TLS cert is invalid');
  }
}

async function registerAndPoll(opts: {
  baseUrl: string;
  fetch: typeof fetch;
  appId: string;
  appName: string;
  deviceIdentityPubKey: string;
  timeoutMs: number;
}): Promise<string> {
  const deadline = Date.now() + opts.timeoutMs;
  const fetchBeforeDeadline = async (url: string, init?: RequestInit): Promise<Response> => {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new Error('pairing: approval deadline expired');
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error('pairing request timed out')),
      remainingMs,
    );
    timeout.unref?.();
    try {
      return await opts.fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  };

  const registerRes = await fetchBeforeDeadline(`${opts.baseUrl}/v1/apps/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      appId: opts.appId,
      appName: opts.appName,
      scopes: ['remote-inference'],
      kind: 'device',
      deviceIdentityPubKey: opts.deviceIdentityPubKey,
    }),
  });
  if (!registerRes.ok) {
    const text = await registerRes.text().catch(() => '');
    throw new Error(`pairing: register returned HTTP ${registerRes.status} ${text}`);
  }
  const registered = (await registerRes.json()) as {
    grantRequestId: string;
    status: 'pending' | 'approved' | 'denied';
    token?: string;
  };
  if (registered.token) return registered.token;

  while (Date.now() < deadline) {
    const waitSec = Math.min(30, Math.max(1, Math.floor((deadline - Date.now()) / 1000)));
    const res = await fetchBeforeDeadline(
      `${opts.baseUrl}/v1/apps/grant/${registered.grantRequestId}?wait=${waitSec}`,
    );
    if (!res.ok) throw new Error(`pairing: grant poll returned HTTP ${res.status}`);
    const body = (await res.json()) as { status: string; token?: string };
    if (body.status === 'approved' && body.token) return body.token;
    if (body.status === 'denied') throw new Error('pairing: the server declined the request');
  }
  throw new Error(`pairing: not approved within ${Math.round(opts.timeoutMs / 1000)}s`);
}
