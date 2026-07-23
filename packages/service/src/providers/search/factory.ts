/**
 * Provider-selection helper for the `web_search` MCP tool.
 *
 * Selection rules (first-match):
 *   1. `GEZEL_MOCK_PROVIDER=1` → MockSearchProvider (tests, CI).
 *   2. `webSearch.provider` set in config → that backend, with a
 *      `webSearch.fallbackProvider` wrapper when also configured.
 *      A configured-but-unavailable primary (missing key) returns a
 *      provider with `unavailableReason` set; the chained wrapper
 *      transparently falls back if `fallbackProvider` is set.
 *   3. Default: WikipediaSearchProvider (zero-key, always available).
 *
 * Construction is per-request — every route call invokes
 * `createSearchProvider` so config / credential changes take effect
 * without rebuild plumbing. Cost is one Store + one secrets read per
 * call, dominated by the actual HTTP search.
 */

import { resolveSecurityPolicy } from '@bendyline/gezel';
import type { Store } from '../../fs/store.js';
import type { SecretStore } from '../../secrets/types.js';
import { BraveSearchProvider } from './brave.js';
import { ChainedSearchProvider } from './chained.js';
import { MockSearchProvider } from './mock.js';
import type { SearchProvider, SearchProviderName } from './types.js';
import { WikipediaSearchProvider } from './wikipedia.js';

export interface SearchProviderFactoryOptions {
  store: Store;
  secrets: SecretStore;
  /** Override for tests. */
  env?: NodeJS.ProcessEnv;
}

export async function createSearchProvider(
  opts: SearchProviderFactoryOptions,
): Promise<SearchProvider> {
  const env = opts.env ?? process.env;

  if (env.GEZEL_MOCK_PROVIDER === '1') {
    return new MockSearchProvider();
  }

  const config = await opts.store.readConfig();

  // Centralized security ceiling: when external services are disabled, no
  // outbound search backend may run — including the zero-key Wikipedia
  // default (a lookup still reveals what's being researched). Returns an
  // unavailable provider so callers surface a clear reason instead of
  // silently hitting the network.
  if (!resolveSecurityPolicy(config).allowExternalServices) {
    return {
      name: config.webSearch?.provider ?? 'wikipedia',
      unavailableReason:
        'External services are disabled by the security policy. Raise the security level in Settings → Security & Compliance to enable web search.',
      // eslint-disable-next-line @typescript-eslint/require-await
      async search() {
        throw new Error('web search disabled by security policy');
      },
    };
  }

  const requested = config.webSearch?.provider;
  const fallbackName = config.webSearch?.fallbackProvider;

  // Default path: no provider configured → Wikipedia. No fallback —
  // Wikipedia is the fallback in spirit.
  if (!requested) {
    return new WikipediaSearchProvider();
  }

  const primary = await buildProvider(requested, opts.secrets);
  if (!fallbackName || fallbackName === requested) {
    return primary;
  }
  const fallback = await buildProvider(fallbackName, opts.secrets);
  return new ChainedSearchProvider(primary, fallback);
}

async function buildProvider(
  name: SearchProviderName,
  secrets: SecretStore,
): Promise<SearchProvider> {
  switch (name) {
    case 'wikipedia':
      return new WikipediaSearchProvider();
    case 'brave': {
      const apiKey = await secrets.get({ kind: 'providerCredential', name: 'braveSearchApiKey' });
      return new BraveSearchProvider({ apiKey });
    }
    case 'tavily': {
      // Tavily is reserved for a future stretch; until the provider
      // class lands we surface a clear unavailable reason so the
      // chained-fallback path still works.
      return {
        name: 'tavily',
        unavailableReason:
          'Tavily provider not yet implemented. Choose Brave or Wikipedia in Settings → Web search.',
        // eslint-disable-next-line @typescript-eslint/require-await
        async search() {
          throw new Error('tavily provider not implemented');
        },
      };
    }
    case 'mock':
      return new MockSearchProvider();
  }
}
