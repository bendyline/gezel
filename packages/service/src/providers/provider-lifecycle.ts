import { ProviderRetirementGate, trackProviderOperations } from './retirement-gate.js';

interface Provider {
  shutdown?(): Promise<void>;
}

interface Generation<T> {
  gate: ProviderRetirementGate;
  build: Promise<T>;
  provider?: T;
  closed: boolean;
  retireWithBroker: boolean;
}

/**
 * Owns one lazy provider generation. Reset and broker retirement close admission
 * before waiting for an in-flight build and admitted work. A failed shutdown
 * retains its generation for retry; no replacement can leak past it.
 */
export class ProviderLifecycle<T extends Provider> {
  private generation?: Generation<T>;
  private transition?: Promise<void>;
  private brokerRetired = false;

  constructor(private readonly operations: ReadonlySet<PropertyKey>) {}

  async current(build: () => Promise<T>, retireWithBroker = true): Promise<T> {
    if (retireWithBroker && this.brokerRetired)
      throw new Error('local provider retired after machine engine adoption');
    if (this.transition) {
      await this.transition;
      return this.current(build, retireWithBroker);
    }
    if (this.generation?.closed) {
      await this.reset();
      return this.current(build, retireWithBroker);
    }
    if (this.generation) return this.generation.build;
    const gate = new ProviderRetirementGate();
    const generation: Generation<T> = {
      gate,
      closed: false,
      retireWithBroker,
      build: Promise.resolve()
        .then(build)
        .then((provider) => {
          generation.provider = provider;
          return trackProviderOperations(provider, gate, this.operations);
        })
        .catch((error) => {
          if (this.generation === generation) this.generation = undefined;
          throw error;
        }),
    };
    this.generation = generation;
    return generation.build;
  }

  reset(): Promise<void> {
    return this.drain('local provider retired during reset; obtain the current provider');
  }

  /** Permanent for native generations; user-owned cloud providers remain usable. */
  retireForMachineBroker(): Promise<void> {
    this.brokerRetired = true;
    if (this.generation && !this.generation.retireWithBroker) return Promise.resolve();
    return this.drain();
  }

  private drain(message?: string): Promise<void> {
    if (this.transition) return this.transition;
    const generation = this.generation;
    if (!generation) return Promise.resolve();
    generation.closed = true;
    generation.gate.beginRetirement(message);
    const run = (async () => {
      // A failed build produced no provider to shut down. Its caller still
      // receives the build error, while retirement can finish successfully.
      await generation.build.catch(() => {});
      await generation.gate.waitForIdle();
      await generation.provider?.shutdown?.();
      if (this.generation === generation) this.generation = undefined;
    })();
    this.transition = run;
    const clear = () => {
      if (this.transition === run) this.transition = undefined;
    };
    void run.then(clear, clear);
    return run;
  }
}
