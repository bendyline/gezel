import { describe, expect, it } from 'vitest';
import { detectStoreBuild } from './store-build.js';

const noMarker = () => null;

describe('detectStoreBuild', () => {
  it('reads the channel from the marker the packaging lane wrote', () => {
    expect(
      detectStoreBuild({
        resourcesPath: '/app/Resources',
        runtime: {},
        readMarker: () => ({ channel: 'mac-app-store' }),
      }),
    ).toEqual({ channel: 'mac-app-store', source: 'marker' });
  });

  it('falls back to the Electron runtime signal when no marker shipped', () => {
    expect(
      detectStoreBuild({
        resourcesPath: '/app/Resources',
        runtime: { mas: true },
        readMarker: noMarker,
      }),
    ).toEqual({ channel: 'mac-app-store', source: 'electron-runtime' });
  });

  it('reports a direct download when neither signal fires', () => {
    expect(
      detectStoreBuild({ resourcesPath: '/app/Resources', runtime: {}, readMarker: noMarker }),
    ).toEqual({ channel: null, source: 'none' });
  });

  it('fails toward the restricted answer on a malformed marker', () => {
    // A marker that exists but names no channel we know is a packaging bug.
    // Guessing "direct download" would let a store build try to download code
    // and be rejected at review; guessing "store" only declines features it
    // could have offered. Only one of those is recoverable after shipping.
    const detected = detectStoreBuild({
      resourcesPath: '/app/Resources',
      runtime: {},
      readMarker: () => ({ channel: 'something-else' }),
    });
    expect(detected.channel).not.toBeNull();
    expect(detected.source).toBe('marker');
  });

  it('lets the marker outrank a missing runtime signal', () => {
    // process.windowsStore is unverified under a full-trust MSIX, so the
    // marker has to be able to answer on its own.
    expect(
      detectStoreBuild({
        resourcesPath: '/app/Resources',
        runtime: { windowsStore: false },
        readMarker: () => ({ channel: 'microsoft-store' }),
      }),
    ).toEqual({ channel: 'microsoft-store', source: 'marker' });
  });
});
