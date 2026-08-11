import { describe, expect, it } from 'vitest';
import { isAllowedHermeticEvalFetchUrl } from './eval-fetch-url.js';

const exactEnv = {
  GEZEL_EVAL_HERMETIC: '1',
  GEZEL_EVAL_FETCH_URL_ALLOWED_ORIGINS: JSON.stringify(['https://127.0.0.1:43123']),
};

describe('isAllowedHermeticEvalFetchUrl', () => {
  it('allows paths on an explicitly listed HTTPS loopback origin', () => {
    expect(isAllowedHermeticEvalFetchUrl('https://127.0.0.1:43123/api/check?run=1', exactEnv)).toBe(
      true,
    );
  });

  it('requires both the eval marker and the exact-origin list', () => {
    expect(
      isAllowedHermeticEvalFetchUrl('https://127.0.0.1:43123/api/check', {
        GEZEL_EVAL_FETCH_URL_ALLOWED_ORIGINS: exactEnv.GEZEL_EVAL_FETCH_URL_ALLOWED_ORIGINS,
      }),
    ).toBe(false);
    expect(
      isAllowedHermeticEvalFetchUrl('https://127.0.0.1:43123/api/check', {
        GEZEL_EVAL_HERMETIC: '1',
      }),
    ).toBe(false);
  });

  it('rejects a different port, scheme, or host', () => {
    expect(isAllowedHermeticEvalFetchUrl('https://127.0.0.1:43124/api/check', exactEnv)).toBe(
      false,
    );
    expect(isAllowedHermeticEvalFetchUrl('http://127.0.0.1:43123/api/check', exactEnv)).toBe(false);
    expect(isAllowedHermeticEvalFetchUrl('https://localhost:43123/api/check', exactEnv)).toBe(
      false,
    );
    expect(isAllowedHermeticEvalFetchUrl('https://example.com/api/check', exactEnv)).toBe(false);
  });

  it('rejects credentials and malformed or pattern-like allowlists', () => {
    expect(
      isAllowedHermeticEvalFetchUrl('https://user:pass@127.0.0.1:43123/api/check', exactEnv),
    ).toBe(false);
    expect(
      isAllowedHermeticEvalFetchUrl('https://127.0.0.1:43123/api/check', {
        GEZEL_EVAL_HERMETIC: '1',
        GEZEL_EVAL_FETCH_URL_ALLOWED_ORIGINS: '["https://127.0.0.1:43123", "*"]',
      }),
    ).toBe(false);
    expect(
      isAllowedHermeticEvalFetchUrl('https://127.0.0.1:43123/api/check', {
        GEZEL_EVAL_HERMETIC: '1',
        GEZEL_EVAL_FETCH_URL_ALLOWED_ORIGINS: 'not-json',
      }),
    ).toBe(false);
  });
});
