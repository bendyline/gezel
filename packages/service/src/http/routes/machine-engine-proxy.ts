import type { MiddlewareHandler } from 'hono';
import type { ServiceContext } from '../context.js';

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
): MiddlewareHandler {
  return async (c, next) => {
    if (localPaths.includes(c.req.path)) {
      await next();
      return;
    }
    const bridge = ctx.machineEngine;
    if (!bridge || (!bridge.isConnected() && !bridge.isRequired())) {
      await next();
      return;
    }
    return bridge.proxy(c.req.raw, sourcePrefix, targetPrefix);
  };
}
