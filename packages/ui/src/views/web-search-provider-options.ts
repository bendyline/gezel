export type WebSearchProviderSetting = 'brave' | 'wikipedia' | 'mock' | 'unset';

export interface WebSearchProviderOption {
  value: WebSearchProviderSetting;
  label: string;
}

const PRODUCTION_WEB_SEARCH_PROVIDER_OPTIONS: readonly WebSearchProviderOption[] = [
  { value: 'unset', label: 'Default (Wikipedia, no key)' },
  { value: 'wikipedia', label: 'Wikipedia (no key)' },
  { value: 'brave', label: 'Brave Search (requires key)' },
];

const MOCK_WEB_SEARCH_PROVIDER_OPTION: WebSearchProviderOption = {
  value: 'mock',
  label: 'Mock (testing)',
};

/**
 * The mock backend is useful to local development and deterministic evals,
 * but it must never appear as an ordinary production setting.
 */
export function webSearchProviderOptions(
  includeTestingProvider: boolean,
): readonly WebSearchProviderOption[] {
  return includeTestingProvider
    ? [...PRODUCTION_WEB_SEARCH_PROVIDER_OPTIONS, MOCK_WEB_SEARCH_PROVIDER_OPTION]
    : PRODUCTION_WEB_SEARCH_PROVIDER_OPTIONS;
}

/**
 * A config written by a development build can survive into a packaged build.
 * Keep that stale test-only value from leaving the production select blank;
 * the next explicit choice writes an ordinary supported provider.
 */
export function visibleWebSearchProviderSetting(
  configured: string | undefined,
  includeTestingProvider: boolean,
): WebSearchProviderSetting {
  if (configured === 'brave' || configured === 'wikipedia') return configured;
  if (configured === 'mock' && includeTestingProvider) return configured;
  return 'unset';
}
