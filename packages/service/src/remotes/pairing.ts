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

import { hostname } from 'node:os';
import { createLogger } from '@bendyline/gezel';
import type { ServiceContext } from '../http/context.js';
import {
  IdentityResponseSchema,
  certFingerprintFromPem,
  fingerprintOfPublicKeyPem,
  verifyIdentitySignature,
} from './identity.js';
import { createInsecureBootstrapFetch, createPinnedFetch } from './pinned-fetch.js';
import type { PairedRemote } from './registry.js';

const log = createLogger('remote-pairing');

export interface PairRemoteInput {
  /** B's base URL, e.g. `https://192.168.1.50:43936`. */
  baseUrl: string;
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
      appId: ctx.deviceIdentity.deviceId,
      appName: input.displayName ?? hostname(),
      deviceIdentityPubKey: ctx.deviceIdentity.publicKeyPem,
      timeoutMs: (input.approvalTimeoutSec ?? 120) * 1000,
    });
  } finally {
    await pinned.close();
  }

  // 4. Persist.
  const paired: PairedRemote = {
    remoteId,
    baseUrl,
    displayName: input.displayName ?? identity.deviceId,
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
