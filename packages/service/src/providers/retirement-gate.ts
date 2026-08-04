/**
 * Tracks long-running provider operations while a machine-engine adoption is
 * retiring the user daemon's local provider. The gate closes before draining:
 * callers that already hold a provider reference cannot start a second local
 * operation after the broker has become authoritative.
 */
export class ProviderRetirementGate {
  private retiring = false;
  private active = 0;
  private readonly idleWaiters = new Set<() => void>();

  beginRetirement(): void {
    this.retiring = true;
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.retiring) {
      throw new Error('local provider retired after machine engine adoption');
    }
    this.active += 1;
    try {
      return await operation();
    } finally {
      this.active -= 1;
      if (this.active === 0) {
        for (const resolve of this.idleWaiters) resolve();
        this.idleWaiters.clear();
      }
    }
  }

  async waitForIdle(): Promise<void> {
    if (this.active === 0) return;
    await new Promise<void>((resolve) => this.idleWaiters.add(resolve));
  }
}

/**
 * Wrap only the operations which can own a native engine. Management calls
 * remain direct, and shutdown is deliberately not counted as user work.
 */
export function trackProviderOperations<T extends object>(
  provider: T,
  gate: ProviderRetirementGate,
  operationNames: ReadonlySet<PropertyKey>,
): T {
  return new Proxy(provider, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      if (!operationNames.has(property)) return value.bind(target);
      return (...args: unknown[]) =>
        gate.run(() => Promise.resolve(Reflect.apply(value, target, args)));
    },
  });
}
