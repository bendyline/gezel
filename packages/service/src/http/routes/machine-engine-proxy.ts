import type { MiddlewareHandler } from 'hono';
import type { ServiceContext } from '../context.js';

export const MACHINE_ENGINE_PROVIDER_NAMES = ['llama-cpp', 'mlx', 'ds4'] as const;
export type MachineEngineProviderName = (typeof MACHINE_ENGINE_PROVIDER_NAMES)[number];

const MACHINE_ENGINE_PROVIDER_SET = new Set<string>(MACHINE_ENGINE_PROVIDER_NAMES);

/** Native chat providers whose process, queue, and prompt cache are broker-owned. */
export function isMachineEngineProvider(name: string): name is MachineEngineProviderName {
  return MACHINE_ENGINE_PROVIDER_SET.has(name);
}

/**
 * True once the broker is the authoritative native-engine owner. A temporarily
 * disconnected adopted broker still returns true: falling back to the user
 * daemon would create a second GPU owner while the system service restarts.
 */
export function usesMachineEngine(ctx: ServiceContext): boolean {
  const bridge = ctx.machineEngine;
  return Boolean(bridge && (bridge.isConnected() || bridge.isRequired()));
}

/**
 * Remote inference namespaces affinity ids before they enter a broker queue or
 * cache. Those transport ids must never escape back into the product API: the
 * renderer opens sessions/projects using the user-owned id after this prefix.
 */
export function userOwnedIdFromBroker(value: string): string {
  const match = /^dev:[^:]+:(.+)$/.exec(value);
  return match?.[1] ?? value;
}

/**
 * Delegate one engine-management router to the machine broker when it has
 * been adopted. If no broker has ever been available, continue locally so
 * developer and per-user-only installations retain today's behavior.
 */
export function machineEngineProxy(
  ctx: ServiceContext,
  sourcePrefix: string,
  targetPrefix: string,
  localPaths: readonly string[] = [],
  shouldProxy?: () => boolean | Promise<boolean>,
): MiddlewareHandler {
  return async (c, next) => {
    if (localPaths.includes(c.req.path) || (shouldProxy && !(await shouldProxy()))) {
      await next();
      return;
    }
    const bridge = ctx.machineEngine;
    if (!bridge || !usesMachineEngine(ctx)) {
      await next();
      return;
    }
    return bridge.proxy(c.req.raw, sourcePrefix, targetPrefix);
  };
}
