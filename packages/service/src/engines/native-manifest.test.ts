import { describe, expect, it } from 'vitest';
import {
  NATIVE_ENGINE_ARCHIVE_SHA256,
  NATIVE_ENGINE_MACOS_NOTARIZED,
  NATIVE_ENGINE_RELEASE,
  SHA256SUMS_DIGEST,
  isEnginePinned,
} from './native-manifest.js';

describe('native release trust manifest', () => {
  it('pins every published archive with an immutable SHA256', () => {
    const entries = Object.entries(NATIVE_ENGINE_ARCHIVE_SHA256);

    expect(entries).toHaveLength(13);
    expect(Object.isFrozen(NATIVE_ENGINE_ARCHIVE_SHA256)).toBe(true);
    for (const [filename, hash] of entries) {
      expect(filename).toContain(`gezel-native-${NATIVE_ENGINE_RELEASE}-`);
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(SHA256SUMS_DIGEST).toMatch(/^[a-f0-9]{64}$/);
    expect(isEnginePinned()).toBe(true);
  });

  it('declares standalone notarization for the accepted-notary release', () => {
    expect(NATIVE_ENGINE_MACOS_NOTARIZED).toBe(true);
  });
});
