import type { ModelTier, Poppetje } from '@bendyline/gezel';

/**
 * What the handboek engine may know about *this install* when rendering
 * in `app` mode. Injected rather than imported so the engine runs
 * identically under the daemon (real store + chat manager), unit tests
 * (stubs), and the CLI static-site export (the site stub below, which
 * knows nothing personal).
 */
export interface HandboekGezelInfo {
  id: string;
  name: string;
  role?: string;
  poppetje?: Poppetje | null;
}

export interface HandboekModelInfo {
  id: string;
  name?: string;
  /** Provider/engine that hosts the model (e.g. `llama-cpp`, `openai`). */
  provider: string;
  parameterSize?: string;
  tier: ModelTier;
}

export interface HandboekDeviceInfo {
  listGezels(): Promise<HandboekGezelInfo[]>;
  meesterGezelId(): Promise<string | null>;
  listInstalledModels(): Promise<HandboekModelInfo[]>;
}

/** Device info for `site`/`agent-less` contexts: nothing personal to tell. */
export const siteDeviceInfo: HandboekDeviceInfo = {
  listGezels: async () => [],
  meesterGezelId: async () => null,
  listInstalledModels: async () => [],
};
