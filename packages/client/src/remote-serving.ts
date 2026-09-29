/** One server this device has paired with (token redacted). */
export interface PairedRemoteInfo {
  remoteId: string;
  baseUrl: string;
  displayName: string;
  pinnedIdentityFingerprint: string;
  scopes: string[];
  pairedAt: number;
  lastSeenAt?: number;
  hasToken: boolean;
}

/** remoteServing config as managed on the machine broker. */
export interface MachineServingConfig {
  enabled?: boolean;
  bindAddress?: string;
  port?: number;
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
