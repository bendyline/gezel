import { describe, expect, it } from 'vitest';
import { makeContextShim } from './context-shim.js';
import { VENDORED } from './vendor/index.js';

/**
 * The one test that catches the `spectral` driver's biggest fragility: vendored
 * components hard-import the PRIVATE path `@prismatic-io/spectral/dist/clients/http`
 * for `createClient`/`handleErrors`. A version bump that moves that path turns
 * into a red build here instead of a silent runtime break.
 */
describe('spectral deep-import guard (pinned 10.23.0)', () => {
  it('createClient + handleErrors live at dist/clients/http', () => {
    const http = require('@prismatic-io/spectral/dist/clients/http');
    expect(typeof http.createClient).toBe('function');
    expect(typeof http.handleErrors).toBe('function');
  });

  it('the public action() + connection() factories exist', () => {
    const spectral = require('@prismatic-io/spectral');
    expect(typeof spectral.action).toBe('function');
    expect(typeof spectral.connection).toBe('function');
  });

  it('the echo vendored action runs off-platform through the context shim', async () => {
    const out = (await VENDORED['echo/list']!.perform(makeContextShim(), {})) as { data: unknown };
    expect(Array.isArray(out.data)).toBe(true);
  });
});
