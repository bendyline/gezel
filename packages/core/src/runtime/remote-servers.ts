/**
 * The phone's side of remote serving: the gezel servers this device paired
 * with, and everything needed to run a turn on one of them.
 *
 * A phone can't serve models to others; it only connects. It pairs with the
 * connect code a server shows (core `remote/pairing.ts`, the same client the
 * desktop runs), keeps each pairing in `remotes.json` (`remotes-file.ts`), and
 * reaches servers through the host's native HTTPS, which pins the server's
 * certificate.
 *
 * A server's certificate rotates every time it restarts; its identity key does
 * not. When the pinned certificate is refused, the server's `/v1/identity` is
 * read again and the new certificate is adopted only if the pinned identity
 * signed it.
 */

import {
  type ClientIdentity,
  PROTOCOL_VERSION,
  type PairedServer,
  RemoteAdmissionResponseSchema,
  type RemoteFetch,
  type RemoteHttp,
  RemoteModelsResponseSchema,
  createClientIdentity,
  makeRemoteModelId,
  normalizeServerOrigin,
  pairWithConnectCode,
  readServerIdentity,
  verifyRemoteIdentity,
} from '../remote/index.js';
import type { PortablePairedServer } from './remotes-file.js';
import type { PortableStore } from './store.js';

export type { PortablePairedServer, PortableRemotes } from './remotes-file.js';

/**
 * Error code a host's pinned fetch puts on the error it throws when the
 * server presented a certificate other than the pinned one — the one failure
 * a certificate refresh can fix.
 */
export const REMOTE_CERTIFICATE_REFUSED = 'REMOTE_CERTIFICATE_REFUSED';

/** What a host provides for reaching other devices. */
export interface PortableRemoteHost {
  http: RemoteHttp;
  /** gezel servers announcing themselves on the local network, when the host can look. */
  browse?(
    waitMs: number,
  ): Promise<Array<{ name: string; host: string; port: number; fingerprint?: string }>>;
  /** What a server calls this device in its list of connected devices. */
  deviceName(): string;
}

export type RemoteServerStatus = 'online' | 'offline' | 'unknown';

export interface RemoteServerInfo {
  remoteId: string;
  baseUrl: string;
  displayName: string;
  pinnedIdentityFingerprint: string;
  pairedAt: number;
  lastSeenAt?: number;
  status: RemoteServerStatus;
}

export interface RemoteServerModel {
  /** Namespaced for this device: `remote:<remoteId>/<the server's id>`. */
  id: string;
  name: string;
  contextWindow?: number;
  supportsTools?: boolean;
  supportsReasoning?: boolean;
  parameterSize?: string;
}

export interface DiscoveredServer {
  name: string;
  address: string;
  port: number;
  baseUrl: string;
  fingerprint?: string;
  pairedRemoteId?: string;
}

const FRESH_MS = 60_000;
const OFFLINE_RECHECK_MS = 15_000;
const PROBE_TIMEOUT_MS = 2_500;
/** A server's own engines answer at once; another provider may start a session first. */
const ADMIT_TIMEOUT_MS = 15_000;

function errorCode(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function hostForUrl(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

export class PortableRemoteServers {
  private readonly reach = new Map<
    string,
    { status: RemoteServerStatus; lastOkAt?: number; lastCheckAt?: number }
  >();
  private readonly inflight = new Map<string, Promise<RemoteServerStatus>>();
  /** The last window each server gave each model, for when it can't say in time. */
  private readonly admitted = new Map<string, number>();

  constructor(
    private readonly store: Pick<PortableStore, 'readRemotes' | 'writeRemotes'>,
    private readonly host: PortableRemoteHost | null,
    private readonly now: () => number = Date.now,
  ) {}

  /** Whether this host can reach other devices at all. */
  get available(): boolean {
    return this.host !== null;
  }

  private requireHost(): PortableRemoteHost {
    if (!this.host) throw new Error('This device cannot connect to other devices.');
    return this.host;
  }

  private async identity(): Promise<ClientIdentity> {
    const remotes = await this.store.readRemotes();
    if (remotes.identity) return remotes.identity;
    const identity = await createClientIdentity();
    await this.store.writeRemotes({ ...remotes, identity });
    return identity;
  }

  async server(remoteId: string): Promise<PortablePairedServer | null> {
    return (await this.store.readRemotes()).servers.find((s) => s.remoteId === remoteId) ?? null;
  }

  private async update(remoteId: string, patch: Partial<PortablePairedServer>): Promise<void> {
    const remotes = await this.store.readRemotes();
    await this.store.writeRemotes({
      ...remotes,
      servers: remotes.servers.map((s) => (s.remoteId === remoteId ? { ...s, ...patch } : s)),
    });
  }

  status(remoteId: string): RemoteServerStatus {
    return this.reach.get(remoteId)?.status ?? 'unknown';
  }

  reportReachable(remoteId: string): void {
    const t = this.now();
    this.reach.set(remoteId, { status: 'online', lastOkAt: t, lastCheckAt: t });
  }

  reportUnreachable(remoteId: string): void {
    const previous = this.reach.get(remoteId);
    this.reach.set(remoteId, {
      status: 'offline',
      ...(previous?.lastOkAt ? { lastOkAt: previous.lastOkAt } : {}),
      lastCheckAt: this.now(),
    });
  }

  async list(): Promise<RemoteServerInfo[]> {
    return (await this.store.readRemotes()).servers.map((s) => ({
      remoteId: s.remoteId,
      baseUrl: s.baseUrl,
      displayName: s.displayName,
      pinnedIdentityFingerprint: s.pinnedIdentityFingerprint,
      pairedAt: s.pairedAt,
      ...(this.reach.get(s.remoteId)?.lastOkAt
        ? { lastSeenAt: this.reach.get(s.remoteId)!.lastOkAt! }
        : s.lastSeenAt
          ? { lastSeenAt: s.lastSeenAt }
          : {}),
      status: this.status(s.remoteId),
    }));
  }

  async discover(): Promise<{ available: boolean; servers: DiscoveredServer[] }> {
    if (!this.host?.browse) return { available: false, servers: [] };
    const paired = (await this.store.readRemotes()).servers;
    const found = await this.host.browse(1_500).catch(() => []);
    for (const s of found) {
      const moved = paired.find((p) => p.pinnedIdentityFingerprint === s.fingerprint);
      if (moved) await this.relocate(moved, `https://${hostForUrl(s.host)}:${s.port}`);
    }
    return {
      available: true,
      servers: found.map((s) => {
        const match = s.fingerprint
          ? paired.find((p) => p.pinnedIdentityFingerprint === s.fingerprint)
          : undefined;
        return {
          name: s.name,
          address: s.host,
          port: s.port,
          baseUrl: `https://${hostForUrl(s.host)}:${s.port}`,
          ...(s.fingerprint ? { fingerprint: s.fingerprint } : {}),
          ...(match ? { pairedRemoteId: match.remoteId } : {}),
        };
      }),
    };
  }

  /**
   * Follow a paired server to the address it now announces (a new DHCP
   * lease), once the server there proves the pinned identity: its identity
   * key hashes to the pinned fingerprint and signs the certificate it shows.
   * Anyone can announce a fingerprint; only the server can sign for it.
   */
  private async relocate(
    server: PortablePairedServer,
    baseUrl: string,
  ): Promise<PortablePairedServer | null> {
    if (baseUrl === server.baseUrl || !this.host) return null;
    try {
      const identity = await readServerIdentity(
        this.host.http,
        baseUrl,
        AbortSignal.timeout(PROBE_TIMEOUT_MS),
      );
      if (
        identity.fingerprint !== server.pinnedIdentityFingerprint ||
        !(await verifyRemoteIdentity(identity))
      )
        return null;
      // A signed identity can be replayed; holding its certificate's key
      // cannot. Only a channel pinned to that certificate proves the server.
      const pinned = this.host.http.pinned(identity.tlsCertPem!);
      try {
        const confirmed = await pinned(`${baseUrl}/v1/identity`, {
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        await confirmed.body?.cancel().catch(() => {});
      } finally {
        void pinned.close?.();
      }
      const moved = { ...server, baseUrl, tlsCertPem: identity.tlsCertPem! };
      await this.update(server.remoteId, { baseUrl, tlsCertPem: moved.tlsCertPem });
      return moved;
    } catch {
      return null;
    }
  }

  /** Look for a paired server that didn't answer at its address, and follow it. */
  private async findElsewhere(server: PortablePairedServer): Promise<PortablePairedServer | null> {
    const found = await this.host?.browse?.(1_000).catch(() => []);
    const seen = found?.find((s) => s.fingerprint === server.pinnedIdentityFingerprint);
    return seen ? this.relocate(server, `https://${hostForUrl(seen.host)}:${seen.port}`) : null;
  }

  /** Whether the server at an address can pair with a connect code. */
  async inspect(baseUrl: string): Promise<{ fingerprint: string; pairingMethods: string[] }> {
    const identity = await readServerIdentity(
      this.requireHost().http,
      normalizeServerOrigin(baseUrl),
    );
    return { fingerprint: identity.fingerprint, pairingMethods: identity.pairingMethods ?? [] };
  }

  async pair(input: { baseUrl: string; code: string }): Promise<RemoteServerInfo> {
    const host = this.requireHost();
    const identity = await this.identity();
    const paired: PairedServer = await pairWithConnectCode(host.http, {
      baseUrl: input.baseUrl,
      code: input.code,
      client: { ...identity, appName: host.deviceName() },
    });
    const remotes = await this.store.readRemotes();
    // One pairing per server and per address: re-pairing replaces the old one.
    const servers = remotes.servers.filter(
      (s) => s.remoteId !== paired.remoteId && s.baseUrl !== paired.baseUrl,
    );
    await this.store.writeRemotes({ ...remotes, servers: [...servers, paired] });
    this.reportReachable(paired.remoteId);
    return {
      remoteId: paired.remoteId,
      baseUrl: paired.baseUrl,
      displayName: paired.displayName,
      pinnedIdentityFingerprint: paired.pinnedIdentityFingerprint,
      pairedAt: paired.pairedAt,
      status: 'online',
    };
  }

  /** Forget a server, and ask it to forget this device (best effort: it may be away). */
  async forget(remoteId: string): Promise<void> {
    const server = await this.server(remoteId);
    if (!server) return;
    const remotes = await this.store.readRemotes();
    if (this.host && remotes.identity) {
      const fetchImpl = this.fetchFor(server);
      await fetchImpl(`${server.baseUrl}/v1/apps/${remotes.identity.deviceId}/token`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${server.token}` },
        signal: AbortSignal.timeout(5_000),
      })
        .then((r) => r.body?.cancel())
        .catch(() => undefined);
    }
    await this.store.writeRemotes({
      ...remotes,
      servers: remotes.servers.filter((s) => s.remoteId !== remoteId),
    });
    this.reach.delete(remoteId);
  }

  /**
   * A fetch to this server over a channel pinned to its certificate. When the
   * certificate is refused — the server restarted and made a new one — its
   * identity is read again, and the new certificate is used (and kept) only if
   * the pinned identity signed it.
   */
  fetchFor(server: PortablePairedServer): typeof fetch {
    const http = this.requireHost().http;
    let current = server;
    let channel: RemoteFetch = http.pinned(current.tlsCertPem);
    return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      try {
        return await channel(input, init);
      } catch (err) {
        if (init?.signal?.aborted || errorCode(err) !== REMOTE_CERTIFICATE_REFUSED) throw err;
        const identity = await readServerIdentity(http, current.baseUrl);
        if (
          identity.fingerprint !== current.pinnedIdentityFingerprint ||
          !(await verifyRemoteIdentity(identity))
        ) {
          throw err;
        }
        current = { ...current, tlsCertPem: identity.tlsCertPem! };
        await this.update(current.remoteId, { tlsCertPem: current.tlsCertPem });
        void channel.close?.();
        channel = http.pinned(current.tlsCertPem);
        return await channel(input, init);
      }
    }) as typeof fetch;
  }

  /**
   * The status to act on before a turn: from memory while fresh, otherwise
   * after a short probe of the server's `/v1/identity`.
   */
  async check(remoteId: string, maxAgeMs = FRESH_MS): Promise<RemoteServerStatus> {
    const server = await this.server(remoteId);
    if (!server || !this.host) return 'offline';
    const seen = this.reach.get(remoteId);
    const t = this.now();
    if (seen?.status === 'online' && seen.lastOkAt !== undefined && t - seen.lastOkAt < maxAgeMs) {
      return 'online';
    }
    if (
      seen?.status === 'offline' &&
      seen.lastCheckAt !== undefined &&
      t - seen.lastCheckAt < OFFLINE_RECHECK_MS
    ) {
      return 'offline';
    }
    const pending = this.inflight.get(remoteId);
    if (pending) return pending;
    const probe = async (target: PortablePairedServer) => {
      const response = await this.fetchFor(target)(`${target.baseUrl}/v1/identity`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      await response.body?.cancel().catch(() => {});
    };
    const run = (async (): Promise<RemoteServerStatus> => {
      try {
        await probe(server);
      } catch {
        const moved = await this.findElsewhere(server);
        if (
          !moved ||
          !(await probe(moved).then(
            () => true,
            () => false,
          ))
        ) {
          this.reportUnreachable(remoteId);
          return 'offline';
        }
      }
      this.reportReachable(remoteId);
      return 'online';
    })().finally(() => this.inflight.delete(remoteId));
    this.inflight.set(remoteId, run);
    return run;
  }

  /** The server's chat models, or the ones it had when last reached. */
  async models(
    remoteId: string,
  ): Promise<{ status: RemoteServerStatus; models: RemoteServerModel[] }> {
    const server = await this.server(remoteId);
    if (!server) return { status: 'offline', models: [] };
    const known = server.knownModels ?? [];
    if ((await this.check(remoteId)) === 'offline') return { status: 'offline', models: known };
    let response: Response;
    try {
      response = await this.fetchFor(server)(`${server.baseUrl}/v1/remote/models`, {
        headers: { Authorization: `Bearer ${server.token}` },
        signal: AbortSignal.timeout(8_000),
      });
    } catch {
      this.reportUnreachable(remoteId);
      return { status: 'offline', models: known };
    }
    this.reportReachable(remoteId);
    // It answered, so it is online, whatever it said: a refusal or a reply
    // this build can't read says nothing about whether it is there.
    const parsed = response.ok
      ? RemoteModelsResponseSchema.safeParse(await response.json().catch(() => null))
      : null;
    if (!parsed?.success) return { status: 'online', models: [] };
    const models: RemoteServerModel[] = parsed.data.models
      .filter((m) => m.modality === 'chat')
      .map((m) => ({
        id: makeRemoteModelId(remoteId, m.id),
        name: m.name,
        ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
        ...(m.supportsTools !== undefined ? { supportsTools: m.supportsTools } : {}),
        ...(m.supportsReasoning !== undefined ? { supportsReasoning: m.supportsReasoning } : {}),
        ...(m.parameterSize ? { parameterSize: m.parameterSize } : {}),
      }));
    if (models.length > 0 && JSON.stringify(models) !== JSON.stringify(known)) {
      await this.update(remoteId, { knownModels: models, lastSeenAt: this.now() });
    }
    return { status: 'online', models };
  }

  /**
   * The context window the server can give this model right now, or `null`
   * when it is there but could not say in time (busy, or starting a model
   * that takes a while), in which case the last window it gave still holds.
   * Throws {@link RemoteServerUnreachableError} when it is not there at all.
   */
  async admit(
    server: PortablePairedServer,
    model: string,
    timeoutMs = ADMIT_TIMEOUT_MS,
  ): Promise<number | null> {
    let response: Response;
    try {
      response = await this.fetchFor(server)(`${server.baseUrl}/v1/remote/admit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${server.token}` },
        body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, model }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if ((error as { name?: unknown })?.name === 'TimeoutError') {
        return this.admitted.get(`${server.remoteId}/${model}`) ?? null;
      }
      this.reportUnreachable(server.remoteId);
      throw new RemoteServerUnreachableError(server.displayName, { cause: error });
    }
    this.reportReachable(server.remoteId);
    if (response.status === 429 || response.status === 503) {
      await response.body?.cancel().catch(() => {});
      return this.admitted.get(`${server.remoteId}/${model}`) ?? null;
    }
    if (!response.ok) {
      const detail = (await response.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
      };
      if (detail.error === 'model_not_loaded') {
        throw new Error(
          `${server.displayName} doesn't have this model ready to run. Choose another of its models in Settings.`,
        );
      }
      throw new Error(
        detail.message ??
          `${server.displayName} could not start this model (HTTP ${response.status}).`,
      );
    }
    // A reply this build can't read still came from a server that is there.
    const parsed = RemoteAdmissionResponseSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) return this.admitted.get(`${server.remoteId}/${model}`) ?? null;
    this.admitted.set(`${server.remoteId}/${model}`, parsed.data.contextWindow);
    return parsed.data.contextWindow;
  }
}

/** The server did not answer: it is asleep, or this device is off its network. */
export class RemoteServerUnreachableError extends Error {
  readonly code = 'remote_unreachable';
  constructor(serverName: string, options?: { cause?: unknown }) {
    super(
      `${serverName} isn't reachable right now. It may be asleep, or this device may not be on its network.`,
      options,
    );
    this.name = 'RemoteServerUnreachableError';
  }
}
