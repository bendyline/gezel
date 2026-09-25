import { describe, expect, it } from 'vitest';
import * as manifest from './engines/native-manifest.js';
import * as nativeRelease from './native-release-entry.js';

describe('native-release entry', () => {
  it('publishes exactly the pin the daemon downloads against', () => {
    expect(nativeRelease.NATIVE_ENGINE_RELEASE).toBe(manifest.NATIVE_ENGINE_RELEASE);
    expect(nativeRelease.SHA256SUMS_DIGEST).toBe(manifest.SHA256SUMS_DIGEST);
    expect(nativeRelease.NATIVE_ENGINE_ARCHIVE_SHA256).toBe(manifest.NATIVE_ENGINE_ARCHIVE_SHA256);
  });

  it('names only archives of the pinned release, each with a sha256', () => {
    // A host staging engines at build time fetches these names and verifies
    // each download against its digest; a stale name would stage the wrong
    // engines for this daemon.
    const release = nativeRelease.NATIVE_ENGINE_RELEASE;
    const entries = Object.entries(nativeRelease.NATIVE_ENGINE_ARCHIVE_SHA256);
    expect(entries.length).toBeGreaterThan(0);
    for (const [archive, sha] of entries) {
      expect(archive.startsWith(`gezel-native-${release}-`), archive).toBe(true);
      expect(sha, archive).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('stays a leaf: the module exports data only', () => {
    expect(Object.keys(nativeRelease).sort()).toEqual([
      'NATIVE_ENGINE_ARCHIVE_SHA256',
      'NATIVE_ENGINE_MACOS_NOTARIZED',
      'NATIVE_ENGINE_RELEASE',
      'SHA256SUMS_DIGEST',
    ]);
  });
});
