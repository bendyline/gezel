import { describe, expect, it } from 'vitest';
import { scopeNeedsVerificationCode } from './scopes.js';

describe('scopeNeedsVerificationCode', () => {
  it('asks for no code when the grant is inference only', () => {
    expect(scopeNeedsVerificationCode(['openai'])).toBe(false);
    expect(scopeNeedsVerificationCode(['remote-inference'])).toBe(false);
    expect(scopeNeedsVerificationCode(['openai', 'remote-inference'])).toBe(false);
  });

  it('asks for a code when any scope carries authority beyond inference', () => {
    expect(scopeNeedsVerificationCode(['product'])).toBe(true);
    expect(scopeNeedsVerificationCode(['cli'])).toBe(true);
    // One stateful scope in an otherwise inference-only set is still stateful.
    expect(scopeNeedsVerificationCode(['openai', 'product'])).toBe(true);
  });

  it('treats an unknown scope as needing a code', () => {
    // Failing closed matters here: a scope this SDK version has never heard of
    // is more likely to be newly added authority than a new inference alias.
    expect(scopeNeedsVerificationCode(['projects'])).toBe(true);
  });

  it('honours an explicit request for the stronger handshake', () => {
    expect(scopeNeedsVerificationCode(['openai'], true)).toBe(true);
  });

  it('does not let an explicit false weaken a stateful grant', () => {
    expect(scopeNeedsVerificationCode(['product'], false)).toBe(true);
  });

  it('asks for no code for an empty scope set', () => {
    expect(scopeNeedsVerificationCode([])).toBe(false);
  });
});
