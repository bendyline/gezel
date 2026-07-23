import { describe, expect, it } from 'vitest';
import {
  DS4_FULL_RESIDENCY_HEADROOM_BYTES,
  DS4_FULL_RESIDENCY_RESERVATION_BYTES,
  canUseDs4FullResidency,
  ds4ResidentBytesForMode,
  planDs4ExpertCache,
  shouldUseDs4SsdStreaming,
} from './residency.js';

const GB = 1024 ** 3;

describe('DS4 residency policy', () => {
  it('keeps streaming on by default, including 128 GB unified-memory targets', () => {
    expect(
      shouldUseDs4SsdStreaming({
        modelSizeBytes: 81 * GB,
        totalRamBytes: 128 * GB,
        platform: 'darwin',
        arch: 'arm64',
      }),
    ).toBe(true);
  });

  it('allows an explicit full-residency request only when this model fits', () => {
    expect(
      shouldUseDs4SsdStreaming({
        configured: false,
        modelSizeBytes: 81 * GB,
        totalRamBytes: 128 * GB,
        platform: 'darwin',
        arch: 'arm64',
      }),
    ).toBe(false);
    expect(
      shouldUseDs4SsdStreaming({
        configured: false,
        modelSizeBytes: 153 * GB,
        totalRamBytes: 128 * GB,
        platform: 'darwin',
        arch: 'arm64',
      }),
    ).toBe(true);
    expect(
      shouldUseDs4SsdStreaming({
        configured: false,
        modelSizeBytes: 153 * GB,
        totalRamBytes: 256 * GB,
        platform: 'darwin',
        arch: 'arm64',
      }),
    ).toBe(false);
  });

  it('does not trust system RAM as discrete GPU capacity', () => {
    expect(
      shouldUseDs4SsdStreaming({
        configured: false,
        modelSizeBytes: 81 * GB,
        totalRamBytes: 256 * GB,
        platform: 'linux',
        arch: 'x64',
      }),
    ).toBe(true);
  });

  it('treats an unknown model size as unsafe for full residency', () => {
    expect(
      shouldUseDs4SsdStreaming({
        configured: false,
        totalRamBytes: 256 * GB,
        platform: 'darwin',
        arch: 'arm64',
      }),
    ).toBe(true);
  });

  it('uses model size plus fixed headroom for the full-residency gate', () => {
    expect(DS4_FULL_RESIDENCY_HEADROOM_BYTES).toBe(32 * GB);
    expect(
      canUseDs4FullResidency({
        modelSizeBytes: 81 * GB,
        totalRamBytes: 128 * GB,
        platform: 'darwin',
        arch: 'arm64',
      }),
    ).toBe(true);
    expect(
      canUseDs4FullResidency({
        modelSizeBytes: 153 * GB,
        totalRamBytes: 128 * GB,
        platform: 'darwin',
        arch: 'arm64',
      }),
    ).toBe(false);
  });

  it('uses model-specific cache guidance and clamps unsafe manual values', () => {
    expect(
      planDs4ExpertCache({
        catalogCacheBytes: 32 * GB,
        catalogResidentBytes: 36 * GB,
        totalRamBytes: 128 * GB,
      }),
    ).toEqual({ cacheGb: 32, requestedGb: 32, clamped: false, safe: true });

    expect(
      planDs4ExpertCache({
        configuredGb: 96,
        catalogCacheBytes: 64 * GB,
        catalogResidentBytes: 80 * GB,
        totalRamBytes: 128 * GB,
      }),
    ).toEqual({ cacheGb: 80, requestedGb: 96, clamped: true, safe: true });
  });

  it('reserves the broker ceiling for a fully resident model', () => {
    expect(ds4ResidentBytesForMode(36 * GB, true)).toBe(36 * GB);
    expect(ds4ResidentBytesForMode(36 * GB, false)).toBe(DS4_FULL_RESIDENCY_RESERVATION_BYTES);
  });
});
