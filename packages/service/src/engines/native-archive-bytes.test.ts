import {
  NATIVE_ENGINE_ARCHIVE_BYTES,
  NATIVE_ENGINE_ARCHIVE_SHA256,
  NATIVE_ENGINE_RELEASE,
  pinnedEngineArchiveBytes,
} from '@bendyline/gezel-inference/internal/engines/native-manifest';
import { describe, expect, it } from 'vitest';

describe('pinned engine archive sizes', () => {
  it('pins a size for every archive it pins a hash for', () => {
    expect(Object.keys(NATIVE_ENGINE_ARCHIVE_BYTES).sort()).toEqual(
      Object.keys(NATIVE_ENGINE_ARCHIVE_SHA256).sort(),
    );
    for (const bytes of Object.values(NATIVE_ENGINE_ARCHIVE_BYTES))
      expect(bytes).toBeGreaterThan(0);
  });

  it('names the archive the resolver fetches for a platform and backend', () => {
    const windowsCuda = `gezel-native-${NATIVE_ENGINE_RELEASE}-win32-x64-cuda.zip`;
    expect(pinnedEngineArchiveBytes('win32-x64', 'cuda', 'win32')).toBe(
      NATIVE_ENGINE_ARCHIVE_BYTES[windowsCuda],
    );
    const macMetal = `gezel-native-${NATIVE_ENGINE_RELEASE}-darwin-arm64-metal.tar.gz`;
    expect(pinnedEngineArchiveBytes('darwin-arm64', 'metal', 'darwin')).toBe(
      NATIVE_ENGINE_ARCHIVE_BYTES[macMetal],
    );
    expect(pinnedEngineArchiveBytes('win32-x64', 'not-a-backend', 'win32')).toBeUndefined();
  });
});
