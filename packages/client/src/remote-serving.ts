/**
 * Whether a paired server could be reached the last time this daemon tried:
 * `unknown` until it has been contacted since the daemon started.
 */
export type RemoteServerStatus = 'online' | 'offline' | 'unknown';

/** One server this device has paired with (token redacted). */
export interface PairedRemoteInfo {
  remoteId: string;
  baseUrl: string;
  displayName: string;
  pinnedIdentityFingerprint: string;
  scopes: string[];
  pairedAt: number;
  /** Last time this daemon actually reached the server. */
  lastSeenAt?: number;
  hasToken: boolean;
  status?: RemoteServerStatus;
  /** When it last failed to reach the server. */
  lastFailAt?: number;
}

/** A model a paired server offers, namespaced `remote:<remoteId>/<model>`. */
export interface RemoteServerModel {
  id: string;
  name: string;
  contextWindow?: number;
  supportsTools?: boolean;
  supportsReasoning?: boolean;
  parameterSize?: string;
}

/**
 * GET /api/remotes/models: every paired server's models, checked in
 * parallel. An `offline` server lists the models it had when last reached.
 */
export interface RemoteServerModelsResponse {
  servers: Array<{
    remoteId: string;
    displayName: string;
    status: RemoteServerStatus;
    models: RemoteServerModel[];
  }>;
}

/** A gezel server another device is announcing on the local network. */
export interface DiscoveredRemoteServer {
  name: string;
  fingerprint: string;
  address: string;
  port: number;
  /** The origin to pair with, e.g. `https://192.168.1.50:6229`. */
  baseUrl: string;
  lastSeenAt: number;
  /** Set when this device has already paired with that server. */
  pairedRemoteId?: string;
}

/** GET /api/remotes/discover. `available: false` → discovery is off on this host. */
export interface DiscoverRemotesResponse {
  available: boolean;
  servers: DiscoveredRemoteServer[];
}

/**
 * The connect code this device shows while someone is adding a device.
 * `code: null` → none showing. `lastPaired` names the device the most recent
 * code connected, so the UI can say so once the code disappears.
 */
export interface PairingCodeState {
  code: string | null;
  expiresAt?: number;
  attemptsLeft?: number;
  lastPaired?: { appName: string; at: number };
}

/** One IPv4 address other devices can reach this one at, best first. */
export interface LanAddressInfo {
  address: string;
  interfaceName: string;
}

/** remoteServing config as managed on the machine broker. */
export interface MachineServingConfig {
  enabled?: boolean;
  bindAddress?: string;
  port?: number;
  advertise?: boolean;
  priority?: 'equal' | 'below-local' | 'above-local';
  reserveLocalGb?: number;
  allowModels?: string[];
  limits?: {
    maxConcurrentPerDevice?: number;
    maxChatPerDevice?: number;
    requestsPerMinute?: number;
  };
}

/**
 * GET/PUT /api/machine-serving response. `config.enabled` reflects the
 * actual listener state; `identity` is the BROKER's device identity (the
 * fingerprint peers verify out-of-band), not the user daemon's.
 */
export interface MachineServingState {
  config: MachineServingConfig;
  status: { listening: boolean; host?: string; port?: number };
  identity: { deviceId: string; fingerprint: string };
}

export interface MachineServingGrant {
  id: string;
  appId: string;
  appName: string;
  scopes: string[];
  status: 'pending' | 'approved' | 'denied' | string;
  createdAt: number;
  decidedAt?: number;
}

export interface MachineServingDevice {
  appId: string;
  appName: string;
  scopes: string[];
  createdAt: number;
  lastUsedAt?: number;
  deviceId?: string;
}
