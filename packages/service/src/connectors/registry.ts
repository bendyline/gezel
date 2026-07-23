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

import type { SecretStore } from '../secrets/types.js';
import type { OAuthTokens } from './oauth.js';
import type { AdapterFactory } from './types.js';

/** SecretStore key holding a binding's credential blob. */
export function connectorSecretKey(type: string, bindingId: string) {
  return { kind: 'toolset' as const, toolsetId: `connector-${type}`, fieldId: bindingId };
}

/** Named-credential alias used by ingest scripts for this binding's secret. */
export function connectorCredentialName(type: string, bindingId: string): string {
  return `connector-${type}.${bindingId}`;
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

/** Register a native adapter factory (called at service startup). */
export function registerNativeAdapter(adapterId: string, factory: AdapterFactory): void {
  NATIVE_ADAPTERS.set(adapterId, factory);
}
