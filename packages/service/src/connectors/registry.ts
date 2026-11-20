/**
 * Connector secret keying + the native-adapter registry. Generalizes mail's
 * `mailSecretKey`/`persistOAuth` (`mail/registry.ts`): a binding's credential
 * blob lives in the SecretStore keyed by connector type + binding id, reachable
 * by the named-credential machinery as `connector-<type>.<bindingId>`.
 *
 * `NATIVE_ADAPTERS` maps an `adapterId` (a `driver:'native'` type's
 * `source.adapterId`) to a factory. The mail + calendar natives register here at
 * service startup; the `mcp`/`script`/`spectral` drivers (Phase 4/5) dispatch
 * separately.
 */

import type { SecretStore } from '@bendyline/gezel-inference/internal/secrets/types';
import type { OAuthTokens } from './oauth.js';
import type { AdapterFactory, ConnectorBindingRef } from './types.js';

/** Every connector credential's name, and its secret's toolset id, starts with this. */
export const CONNECTOR_CREDENTIAL_PREFIX = 'connector-';

/** SecretStore key holding a binding's credential blob. */
export function connectorSecretKey(type: string, bindingId: string) {
  return {
    kind: 'toolset' as const,
    toolsetId: `${CONNECTOR_CREDENTIAL_PREFIX}${type}`,
    fieldId: bindingId,
  };
}

/** Named-credential alias used by ingest scripts for this binding's secret. */
export function connectorCredentialName(type: string, bindingId: string): string {
  return `${CONNECTOR_CREDENTIAL_PREFIX}${type}.${bindingId}`;
}

/** A re-persist callback for a rotated OAuth credential, bound to a secret key. */
export function persistOAuthTo(
  secrets: SecretStore,
  key: ReturnType<typeof connectorSecretKey>,
  merge: (tokens: OAuthTokens) => unknown,
): (tokens: OAuthTokens) => Promise<void> {
  return async (tokens) => {
    await secrets.set(key, JSON.stringify(merge(tokens)));
  };
}

/** Registry of `driver:'native'` adapters, keyed by `source.adapterId`. */
export const NATIVE_ADAPTERS = new Map<string, AdapterFactory>();

/**
 * Optional per-adapter hooks beside the factory, for checks a JSON schema
 * cannot express and status a corpus walk cannot give cheaply.
 */
export interface NativeAdapterExtras {
  /**
   * Field-level problems with a binding's config, in words a person can act
   * on (`"example" is not a web address`). Run at bind and edit, after the
   * manifest's schema passes. Empty when the config is fine.
   */
  validateConfig?(config: Record<string, unknown>): string[];
  /**
   * Config keys that say where the binding sends its credential (a server
   * address, an API base, a host). Changing one is changing who receives the
   * sign-in, so only the person's own app may do it.
   */
  destinationKeys?: readonly string[];
  /**
   * One short line for the Connections row (`Saved 40 of about 150 pages`).
   * Read from the adapter's private state; must not touch the network.
   */
  describeStatus?(ctx: {
    stateDir: string;
    binding: ConnectorBindingRef;
  }): Promise<string | undefined>;
}

export const NATIVE_ADAPTER_EXTRAS = new Map<string, NativeAdapterExtras>();

/** Register a native adapter factory (called at service startup). */
export function registerNativeAdapter(
  adapterId: string,
  factory: AdapterFactory,
  extras?: NativeAdapterExtras,
): void {
  NATIVE_ADAPTERS.set(adapterId, factory);
  if (extras) NATIVE_ADAPTER_EXTRAS.set(adapterId, extras);
}
