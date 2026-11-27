import type { ServiceContext } from '../http/context.js';

/**
 * Something that answers every property and call with itself, so route
 * modules can be built and handlers can run without a service behind them.
 * `overrides` supplies the members a test needs to behave for real.
 */
export function inert(overrides: Record<PropertyKey, unknown> = {}): unknown {
  const handler: ProxyHandler<() => unknown> = {
    get(_target, key) {
      if (key in overrides) return overrides[key];
      if (key === Symbol.toPrimitive) return () => '';
      if (key === Symbol.iterator || key === Symbol.asyncIterator) return undefined;
      if (key === 'then') return undefined;
      return proxy;
    },
    apply() {
      return proxy;
    },
  };
  const proxy: unknown = new Proxy(() => undefined, handler);
  return proxy;
}

/**
 * A service context with nothing behind it, for tests that build the real
 * `buildApp` to enumerate or probe its routes. `home` must be a real folder:
 * a few route modules build paths from it while they are constructed.
 */
export function inertServiceContext(
  home: string,
  overrides: Record<PropertyKey, unknown> = {},
): ServiceContext {
  return inert({ home, ...overrides }) as ServiceContext;
}
