import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Testing-library's auto-cleanup hook only registers itself when global
// test functions are exposed (vitest globals=true). We keep globals=false
// for explicit imports, so unmount the previous render manually.
afterEach(() => {
  cleanup();
});

/**
 * Stable shape for `window.__GEZEL__` so view code that reads `platform`,
 * `mode`, etc. doesn't crash before the test gets a chance to assert.
 * Individual tests can overwrite specific fields.
 */
if (typeof window !== 'undefined') {
  (window as unknown as { __GEZEL__?: Record<string, unknown> }).__GEZEL__ = {
    token: 'test-token',
    baseUrl: 'http://127.0.0.1:0',
    platform: 'linux',
    mode: 'embedded',
    fallbackReason: null,
  };
}
