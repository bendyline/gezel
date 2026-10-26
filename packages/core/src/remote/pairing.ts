/**
 * Pairing with a connect code — the client half, for any host. The daemon
 * runs it over undici and the phone over its native transport; both reach the
 * server's `/v1/identity` and `/v1/apps/pair/*` the same way, so a desktop and
 * a phone pairing with one server run the identical protocol.
 *
 * The server shows an 8-digit code (Settings → Remote Servers → Add a
 * device). The client runs SPAKE2 with it over a TLS channel pinned to the
 * certificate the server's `/v1/identity` presented and its identity key
 * signed. Both device
 * fingerprints are in the transcript, so a run that confirms proves the
 * server is the device showing the code the person typed: that is the
 * out-of-band check, and no identity-code comparison is needed. The server
 * issues its token only after the client's confirmation checks out, and the
 * client keeps it only after the server's does.
 */

import { base64ToBytes, bytesToBase64 } from './bytes.js';
import {
  type ClientIdentity,
  type RemoteIdentity,
  RemoteIdentitySchema,
  verifyRemoteIdentity,
} from './identity.js';
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
/** The LAN listener's default port. */
export const DEFAULT_REMOTE_SERVING_PORT = 6229;

/** `48210937`, `4821 0937`, and `4821-0937` are the same code; anything else is not one. */
export function normalizePairingCode(input: string): string | null {
  const digits = input.replace(/[\s-]/g, '');
  return new RegExp(`^\\d{${PAIRING_CODE_DIGITS}}$`).test(digits) ? digits : null;
}

export function pairingPasswordScalar(code: string): Promise<bigint> {
  return passwordScalar(code, PAIRING_PROTOCOL);
}

function isIpLiteral(host: string): boolean {
  if (host.startsWith('[') && host.endsWith(']')) return host.length > 2;
  const parts = host.split('.');
  return (
    parts.length === 4 &&
    parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255 && String(Number(p)) === p)
  );
}

/**
 * The exact HTTPS origin pairing accepts. The serving side answers only
 * requests addressed to an IP literal (a DNS name could be rebound), so a
 * name is refused here rather than pairing and then failing every request.
 * A bare address (`192.168.1.50`, `192.168.1.50:7000`) means HTTPS, on the
 * serving port unless it names one.
 */
export function normalizeServerOrigin(input: string): string {
  const trimmed = input.trim();
  const bare = !/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  let url: URL;
  try {
    url = new URL(bare ? `https://${trimmed}` : trimmed);
    if (bare && !url.port && !/:\d+\/?$/.test(trimmed)) {
      url.port = String(DEFAULT_REMOTE_SERVING_PORT);
    }
  } catch {
    throw new Error('That is not a server address. Try one like https://192.168.1.50:6229.');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'A server address is just https:// and its IP, like https://192.168.1.50:6229.',
    );
  }
  if (!isIpLiteral(url.hostname)) {
    throw new Error("Use the server's IP address, like https://192.168.1.50:6229.");
  }
  return url.origin;
}

/** `fetch` plus an optional `close()` for transports that hold a connection pool. */
export type RemoteFetch = typeof fetch & { close?(): Promise<void> };

/**
 * How a host reaches a server on the LAN. The server's certificate is
 * self-signed and names 127.0.0.1, so neither channel checks hostnames:
 * `bootstrap` trusts any certificate (only for reading `/v1/identity` before
 * anything is pinned) and `pinned` trusts exactly one.
 */
export interface RemoteHttp {
  bootstrap(): RemoteFetch;
  pinned(certPem: string): RemoteFetch;
}

/** What a client keeps for a server it paired with. */
export interface PairedServer {
  /** The server's identity fingerprint, which never changes. */
  remoteId: string;
  baseUrl: string;
  displayName: string;
  token: string;
  pinnedIdentityKey: string;
  pinnedIdentityFingerprint: string;
  tlsCertPem: string;
  scopes: string[];
  pairedAt: number;
}

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
    super("That device's gezel is too old for connect codes. Update it, then try again.");
    this.name = 'PairingCodeUnsupportedError';
  }
}

async function closeQuietly(fetchImpl: RemoteFetch): Promise<void> {
  await fetchImpl.close?.().catch(() => undefined);
}

const IDENTITY_UNVERIFIED = "That server's identity doesn't check out.";

/**
 * The server's identity, read before anything is pinned. Its key must hash to
 * its fingerprint and must have signed the certificate it presents; whether it
 * is the *right* server is what the connect code proves.
 *
 * The signature is what makes the pin safe. SPAKE2 binds the two device
 * fingerprints, not the TLS channel, so without it anyone who answers for the
 * server's address could present the real identity beside their own
 * certificate, relay the exchange to the real server, and read the token the
 * server returns over the channel this client pinned to them.
 */
export async function readServerIdentity(
  http: RemoteHttp,
  baseUrl: string,
  signal?: AbortSignal,
): Promise<RemoteIdentity> {
  const bootstrap = http.bootstrap();
  try {
    const response = await bootstrap(`${baseUrl}/v1/identity`, {
      signal: signal ?? AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`That address answered with HTTP ${response.status}.`);
    const identity = RemoteIdentitySchema.parse(await response.json());
    if (!(await verifyRemoteIdentity(identity))) throw new Error(IDENTITY_UNVERIFIED);
    return identity;
  } finally {
    await closeQuietly(bootstrap);
  }
}

async function postJson(
  fetchImpl: RemoteFetch,
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

/** Pair with the code a server is showing. */
export async function pairWithConnectCode(
  http: RemoteHttp,
  input: {
    baseUrl: string;
    code: string;
    client: ClientIdentity & { appName: string };
    /** What this client calls the server; defaults to the name it reports. */
    displayName?: string;
    /** The identity already read for this address, to skip a second round trip. */
    identity?: RemoteIdentity;
  },
): Promise<PairedServer> {
  const baseUrl = normalizeServerOrigin(input.baseUrl);
  const code = normalizePairingCode(input.code);
  if (!code) throw new PairingCodeRejectedError();
  const identity = input.identity ?? (await readServerIdentity(http, baseUrl));
  if (input.identity && !(await verifyRemoteIdentity(input.identity))) {
    throw new Error(IDENTITY_UNVERIFIED);
  }
  if (!identity.pairingMethods?.includes('code')) throw new PairingCodeUnsupportedError();

  const pinned = http.pinned(identity.tlsCertPem!);
  let token: string;
  let reportedName: string | undefined;
  try {
    const state = spake2Start('A', await pairingPasswordScalar(code));
    const start = await postJson(pinned, `${baseUrl}/v1/apps/pair/start`, {
      appId: input.client.deviceId,
      appName: input.client.appName,
      deviceIdentityPubKey: input.client.publicKeyPem,
      share: bytesToBase64(state.share),
    });
    if (start.status === 409) throw new PairingCodeClosedError();
    if (start.status === 429) throw new PairingCodeAttemptsError();
    if (start.status === 404) throw new PairingCodeUnsupportedError();
    if (start.status !== 200 || typeof start.json.sessionId !== 'string') {
      throw new Error(`Pairing failed: the server answered HTTP ${start.status}.`);
    }
    let keys: Awaited<ReturnType<typeof spake2Finish>>;
    try {
      keys = await spake2Finish(state, {
        idA: input.client.fingerprint,
        idB: identity.fingerprint,
        peerShare: base64ToBytes(String(start.json.share ?? '')),
        aad: PAIRING_PROTOCOL,
      });
    } catch (err) {
      if (err instanceof Spake2Error) throw new PairingCodeRejectedError();
      throw err;
    }
    const finish = await postJson(pinned, `${baseUrl}/v1/apps/pair/finish`, {
      sessionId: start.json.sessionId,
      confirm: bytesToBase64(keys.confirmA),
    });
    if (finish.status === 403) throw new PairingCodeRejectedError();
    if (finish.status !== 200 || typeof finish.json.token !== 'string') {
      throw new Error(`Pairing failed: the server answered HTTP ${finish.status}.`);
    }
    if (!confirmationsMatch(keys.confirmB, base64ToBytes(String(finish.json.confirm ?? '')))) {
      throw new PairingCodeRejectedError();
    }
    token = finish.json.token;
    if (typeof finish.json.name === 'string') reportedName = finish.json.name.trim().slice(0, 120);
  } finally {
    await closeQuietly(pinned);
  }

  return {
    remoteId: identity.fingerprint,
    baseUrl,
    displayName: input.displayName?.trim() || reportedName || new URL(baseUrl).hostname,
    token,
    pinnedIdentityKey: identity.publicKeyPem,
    pinnedIdentityFingerprint: identity.fingerprint,
    tlsCertPem: identity.tlsCertPem!,
    scopes: ['remote-inference'],
    pairedAt: Date.now(),
  };
}
