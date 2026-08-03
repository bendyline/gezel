/**
 * SecretStore — the one place secrets (API tokens, webhook keys, OAuth
 * access tokens) live at rest. Two implementations ship:
 *
 *   - KeyringSecretStore: native OS keychain (macOS Keychain / Windows
 *     Credential Manager / Linux Secret Service). Preferred.
 *   - FileSecretStore:    AES-256-GCM encrypted file with a 0600 key.
 *     Fallback when the OS keyring is unavailable (headless CI, locked
 *     session, missing libsecret on bare Linux, etc).
 *
 * Toolset secrets are keyed globally by `(toolsetId, fieldId)` — there's
 * one config per toolset regardless of which scope uses it. Per-scope
 * overrides can add a `scope` axis to SecretKey later without breaking
 * existing callers.
 */

import { createHash } from 'node:crypto';
import { resolve as resolvePath } from 'node:path';

export type SecretKey =
  | { kind: 'toolset'; toolsetId: string; fieldId: string }
  | { kind: 'providerCredential'; name: ProviderCredentialName }
  // Private record for this device's stable identity keypair (Ed25519 PKCS#8
  // PEM plus deviceId in a versioned envelope; legacy entries are bare PEM).
  // Signs the rotating TLS cert fingerprint so a paired client can verify
  // continuity across reboots. The public half + deviceId also live in the
  // non-secret device-identity.json.
  //
  // `scope` namespaces the entry to one GEZEL_HOME. It is REQUIRED for new
  // writes and omitted only when addressing the legacy un-namespaced
  // entry during migration. Without it, two homes under one OS login (and
  // the desktop app vs a dev home) collide on a single login-global keychain
  // account: the second one to initialize finds no public identity file,
  // generates a fresh keypair, and its write lands on an entry the OS already
  // holds — surfacing on macOS as "The specified item already exists in the
  // keychain" and taking the daemon down at boot. See remotes/identity.ts.
  | { kind: 'deviceIdentity'; scope?: string };

export type ProviderCredentialName =
  | 'githubToken'
  | 'openaiApiKey'
  | 'openaiOrganization'
  | 'anthropicApiKey'
  | 'googleAiApiKey'
  | 'webhookBearerToken'
  | 'webhookBasicAuth'
  | 'braveSearchApiKey'
  | 'tavilyApiKey';

export interface SecretStore {
  get(key: SecretKey): Promise<string | null>;
  set(key: SecretKey, value: string): Promise<void>;
  delete(key: SecretKey): Promise<void>;
  has(key: SecretKey): Promise<boolean>;
  /** Field ids with a stored value for the given toolset. */
  listForToolset(toolsetId: string): Promise<string[]>;
  /** Short label identifying which backend is in use (for logs + UI banner). */
  readonly backend: SecretStoreBackend;
}

export type SecretStoreBackend = 'keyring' | 'file';

/** A backend outage must never be mistaken for an absent credential. */
export class SecretBackendUnavailableError extends Error {
  constructor(
    readonly backend: SecretStoreBackend,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'SecretBackendUnavailableError';
  }
}

export class SecretStoreCorruptError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SecretStoreCorruptError';
  }
}

/** Canonical string form of a SecretKey, used as an account name in the
 * keyring backend and as a map key in the file backend. Callers should
 * treat this as opaque. */
export function stringifySecretKey(key: SecretKey): string {
  switch (key.kind) {
    case 'toolset':
      return `toolset:${key.toolsetId}:${key.fieldId}`;
    case 'providerCredential':
      return `providerCredential:${key.name}`;
    case 'deviceIdentity':
      return key.scope === undefined
        ? LEGACY_DEVICE_IDENTITY_ACCOUNT
        : `deviceIdentity:${key.scope}`;
  }
}

/** Account name of the legacy un-namespaced device identity entry. Only
 *  the migration path in remotes/identity.ts may address it. */
export const LEGACY_DEVICE_IDENTITY_ACCOUNT = 'deviceIdentity';

/**
 * Stable, opaque namespace for one GEZEL_HOME's private identity. The same
 * path resolves to the same account after a home is deleted and recreated,
 * while two intentional homes under one OS login do not share a key.
 */
export function deviceIdentityScope(home: string): string {
  return createHash('sha256').update(resolvePath(home)).digest('hex').slice(0, 16);
}

/** Prefix used by listForToolset to match a toolset's entries. */
export function toolsetKeyPrefix(toolsetId: string): string {
  return `toolset:${toolsetId}:`;
}
