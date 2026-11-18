import { describe, expect, it } from 'vitest';
import { makeContextShim } from './context-shim.js';
import { VENDORED } from './vendor/index.js';

/**
 * What the runner and the published components rely on from the pinned SDK,
 * through its public exports only. A bump that moves or drops one of these
 * fails here instead of at a person's first sync.
 */
describe('the pinned Spectral SDK', () => {
  it('is exactly pinned, and at least the 10.39 line the published components need', () => {
    const manifest = require('../package.json');
    const pin = manifest.dependencies['@prismatic-io/spectral'] as string;
    expect(pin).toMatch(/^\d+\.\d+\.\d+$/);
    const [major, minor] = pin.split('.').map(Number);
    expect(major === 10 && (minor ?? 0) >= 39).toBe(true);
    const installed = require('@prismatic-io/spectral/package.json').version;
    expect(installed).toBe(pin);
  });

  it('exports the HTTP client publicly', () => {
    const http = require('@prismatic-io/spectral/http');
    expect(typeof http.createClient).toBe('function');
    expect(typeof http.handleErrors).toBe('function');
  });

  it('exports what a callable component and the runner need', () => {
    const spectral = require('@prismatic-io/spectral');
    for (const name of [
      'action',
      'connection',
      'component',
      'pollingTrigger',
      'callableComponent',
    ]) {
      expect(typeof spectral[name], name).toBe('function');
    }
    const context = require('@prismatic-io/spectral/dist/serverTypes/asyncContext');
    expect(typeof context.runWithContext).toBe('function');
  });

  it('the echo vendored action runs off-platform through the context shim', async () => {
    const out = (await VENDORED['echo/list']!.perform(makeContextShim(), {})) as { data: unknown };
    expect(Array.isArray(out.data)).toBe(true);
  });
});
