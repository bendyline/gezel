import { describe, expect, it } from 'vitest';
import { resolveDefaultProviderName } from './default-provider.js';

describe('resolveDefaultProviderName', () => {
  it("respects the user's explicit choice on every platform", () => {
    expect(resolveDefaultProviderName({ provider: 'openai' }, 'darwin', 'arm64')).toBe('openai');
    expect(resolveDefaultProviderName({ provider: 'copilot' }, 'linux', 'x64')).toBe('copilot');
  });

  // The point of the change: an install that never picked a provider should
  // talk to hardware it already has, not to a cloud runtime it may not have
  // downloaded.
  it('defaults to the on-device engine wherever we bundle one', () => {
    expect(resolveDefaultProviderName({}, 'darwin', 'arm64')).toBe('mlx');
    expect(resolveDefaultProviderName({}, 'linux', 'x64')).toBe('llama-cpp');
    expect(resolveDefaultProviderName({}, 'linux', 'arm64')).toBe('llama-cpp');
    expect(resolveDefaultProviderName({}, 'win32', 'x64')).toBe('llama-cpp');
  });

  // Intel Mac ships no engine, so pointing the default at one would produce
  // "no engine bundled" on the first message. Copilot is the honest fallback
  // there — and now fails with an actionable "install it in Settings".
  it('falls back to copilot where no engine is bundled', () => {
    expect(resolveDefaultProviderName({}, 'darwin', 'x64')).toBe('copilot');
    expect(resolveDefaultProviderName({}, 'win32', 'arm64')).toBe('copilot');
  });

  it('handles a missing config the same as an unset provider', () => {
    expect(resolveDefaultProviderName(null, 'darwin', 'arm64')).toBe('mlx');
    expect(resolveDefaultProviderName(undefined, 'linux', 'x64')).toBe('llama-cpp');
  });
});
