export interface RemoteKnownModel {
  id: string;
  name: string;
  contextWindow?: number;
  supportsTools?: boolean;
  supportsReasoning?: boolean;
  parameterSize?: string;
}

export interface PairedRemote {
  /** Stable id A assigns to this server = its full identity fingerprint. */
  remoteId: string;
  /** Base URL A reaches the server at, e.g. `https://192.168.1.50:6229`. */
  baseUrl: string;
  /** Human label shown in A's model picker / Remote Servers panel. */
  displayName: string;
  /** Per-device bearer token the server issued A (scope `remote-inference`). */
  token: string;
  /** The server's identity public key (SPKI PEM), pinned at pairing (TOFU). */
  pinnedIdentityKey: string;
  /** Hex SHA-256 of the pinned identity key — the comparable fingerprint. */
  pinnedIdentityFingerprint: string;
  /**
   * The server's current TLS cert (PEM), used as the CA for A's trusting
   * fetch. Refreshed from `/v1/identity` when the server rotates it; the
   * identity signature is what proves continuity, not this cert.
   */
  tlsCertPem?: string;
  /** Scopes the server granted (currently `['remote-inference']`). */
  scopes: string[];
  /**
   * `gezelVersion` from the peer's `/v1/identity`, when it reported one.
   * Absent for a peer too old to publish it. Read by the native-capacity
   * authority check, which must know whether the broker deciding this
   * machine's memory is the same build as the one asking.
   */
  gezelVersion?: string;
  pairedAt: number;
  /** Last time A successfully reached this server (in-memory unless flushed). */
  lastSeenAt?: number;
  /**
   * The server's chat models the last time A listed them, already namespaced
   * for A. Kept so a picker can show them, marked unavailable, while the
   * server is asleep or A is off its network.
   */
  knownModels?: RemoteKnownModel[];
  /**
   * Runtime-managed connections are never persisted and cannot be removed by
   * the ordinary pairing UI. Today the only managed peer is this computer's
   * machine-wide engine broker.
   */
  managed?: 'machine-engine';
}

export interface RemotesRegistry {
  list(): PairedRemote[];
  get(remoteId: string): PairedRemote | null;
  /** Upsert a paired server. Re-pairing the same id or base URL replaces it atomically. */
  add(remote: PairedRemote): Promise<void>;
  /** Install/replace a runtime-only peer without writing its rotating token. */
  setEphemeral(remote: PairedRemote): void;
  /** Remove a runtime-only peer. Persisted pairings are never affected. */
  removeEphemeral(remoteId: string): boolean;
  /** Patch fields of an existing entry (token rotation, cert refresh, re-pin). */
  update(remoteId: string, patch: Partial<Omit<PairedRemote, 'remoteId'>>): Promise<boolean>;
  /** Forget a server. Returns true if a record was removed. */
  remove(remoteId: string): Promise<boolean>;
  /** Bump `lastSeenAt` in memory (no disk write). */
  touch(remoteId: string): void;
}
