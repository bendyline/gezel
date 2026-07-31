import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

// View tests routinely wait on a chain of effects (load projects -> pick a
// default -> load that project's scripts), each of which needs its own render
// pass. Testing-library's 1s default is enough in isolation but not when the
// whole workspace suite runs in parallel and jsdom workers contend for the CPU
// — that showed up as spurious "unable to find role=option" failures. waitFor
// still resolves as soon as the condition holds, so a larger ceiling only
// stretches the failing path.
configure({ asyncUtilTimeout: 5000 });

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
