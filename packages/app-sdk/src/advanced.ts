/**
 * `@bendyline/gezel-app-sdk/advanced` — the escape hatch, and its price.
 *
 * Everything here reaches Gezel's internal product client. That surface is
 * hundreds of methods wide, it is versioned with the daemon rather than with
 * this SDK, and it speaks Gezel's own vocabulary — gezels, craftbooks,
 * voormen. Nothing in it is part of the stable contract, and a minor daemon
 * release may change any of it.
 *
 * It lives behind its own subpath so that reaching for it is a visible
 * decision in a consuming app's imports, rather than something that happens by
 * autocomplete off the {@link Gezel} object. If you find yourself here for
 * something durable, that is a missing feature on the supported surface: ask
 * for it instead.
 */
import type { GezelClient } from '@bendyline/gezel-client/node';
import type { Gezel } from './gezel.js';

/**
 * The daemon's full product client.
 *
 * Unsupported and unversioned. See the module note above.
 */
export function unsafeProductClient(gezel: Gezel): GezelClient {
  return gezel.client;
}

export type { DaemonConnection } from './host-types.js';
