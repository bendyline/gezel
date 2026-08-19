import { describe, expect, it } from 'vitest';
import {
  visibleWebSearchProviderSetting,
  webSearchProviderOptions,
} from './web-search-provider-options.js';

describe('web search provider settings', () => {
  it('never offers the mock backend in production', () => {
    expect(webSearchProviderOptions(false).map((option) => option.value)).toEqual([
      'unset',
      'wikipedia',
      'brave',
    ]);
  });

  it('keeps the mock backend available to development and test builds', () => {
    expect(webSearchProviderOptions(true)).toContainEqual({
      value: 'mock',
      label: 'Mock (testing)',
    });
  });

  it('renders a stale mock config as the normal default in production', () => {
    expect(visibleWebSearchProviderSetting('mock', false)).toBe('unset');
    expect(visibleWebSearchProviderSetting('mock', true)).toBe('mock');
  });

  it('does not leave the select blank for a provider not offered by this UI', () => {
    expect(visibleWebSearchProviderSetting('tavily', false)).toBe('unset');
  });
});
