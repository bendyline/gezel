/**
 * Assets the service tarball must carry, and the native-release pin.
 *
 * `packages/service/tsup.config.ts` stages two trees into `dist/` in an
 * `onSuccess` hook rather than through the TypeScript build:
 *
 *   dist/ui/               the web UI, so `gezel start --web` works from a
 *                          Node-only npm install with nothing else fetched
 *   dist/handboek-content/ the end-user handbook the daemon serves
 *
 * A hook is a silent-failure surface: if it stops running, the build still
 * succeeds, the tarball still publishes, and the failure only shows up as a
 * blank page for a user who installed from npm.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  NATIVE_ENGINE_RELEASE,
  SHA256SUMS_DIGEST,
  isPlaceholderDigest,
} from '../../packages/service/src/engines/native-manifest';
import { loadPublishedPackages } from './_packages';

const service = loadPublishedPackages().find((p) => p.dir === 'service')!;

describe('service bundled assets', () => {
  it('stages the web UI into dist/ui', () => {
    expect(existsSync(resolve(service.dist, 'ui/index.html'))).toBe(true);
  });

  it('stages the handboek content', () => {
    expect(existsSync(resolve(service.dist, 'handboek-content'))).toBe(true);
  });

  it('does not ship the browser ffmpeg runtime', () => {
    expect(existsSync(resolve(service.dist, 'ui/ffmpeg-core/ffmpeg-core.js'))).toBe(false);
    expect(existsSync(resolve(service.dist, 'ui/ffmpeg-core/ffmpeg-core.wasm'))).toBe(false);
  });
});

describe('native engine release pin', () => {
  it('points at a real release, not the placeholder', () => {
    // A placeholder digest makes `isEnginePinned()` false, which silently
    // disables on-device engine auto-download for everyone who installed
    // from npm — they have no bundled binaries and no repo checkout to fall
    // back to. Re-pin with `node scripts/pin-native-release.mjs --latest`.
    expect(isPlaceholderDigest(SHA256SUMS_DIGEST)).toBe(false);
    expect(NATIVE_ENGINE_RELEASE).not.toBe('0.0.0');
    expect(NATIVE_ENGINE_RELEASE).toMatch(/^\d+\.\d+\.\d+/);
    expect(SHA256SUMS_DIGEST).toMatch(/^[0-9a-f]{64}$/);
  });
});
