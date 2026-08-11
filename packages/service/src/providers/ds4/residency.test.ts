import { describe, expect, it } from 'vitest';
import {
  DS4_FULL_RESIDENCY_HEADROOM_BYTES,
  DS4_FULL_RESIDENCY_RESERVATION_BYTES,
  canUseDs4FullResidency,
  ds4ProjectedResidentBytes,
  ds4ResidentBytesForMode,
  ds4ResidentLine,
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

  it('re-bases the authored footprint onto another context window', () => {
    // DeepSeek V4 Flash IQ2_XXS as ds4-server itself reports it: 36 GiB at
    // ctx=131072, of which 1 GiB is compressed KV (8192 B/token).
    const line = ds4ResidentLine({
      residentBytes: 36 * GB,
      kvBytesPerToken: 8192,
      residentCtxTokens: 131_072,
    });
    expect(line).toEqual({ contextFreeBytes: 35 * GB, kvBytesPerToken: 8192 });
    // Round-trips at the window it was measured at, and moves by ~1 GiB per
    // 128K — the whole reason quoting the flat number tells the user nothing.
    expect(ds4ProjectedResidentBytes(line!, 131_072)).toBe(36 * GB);
    expect(ds4ProjectedResidentBytes(line!, 262_144)).toBe(37 * GB);
    expect(ds4ProjectedResidentBytes(line!, 65_536)).toBe(35.5 * GB);
  });

  it('reconciles GLM 5.2 with the MLA cost its README documents', () => {
    // 57.15 GiB at its 64K cap = 19.6 GiB non-routed weights + 32 GiB expert
    // cache + 89 KiB/token of MLA KV. The slope is 11x DeepSeek's, which is
    // exactly why the same 128K window is affordable on one and not the other.
    const line = ds4ResidentLine({
      residentBytes: 61_363_217_408,
      kvBytesPerToken: 89 * 1024,
      residentCtxTokens: 65_536,
    });
    expect(line?.contextFreeBytes).toBeCloseTo(51.59 * GB, -8);
    expect(ds4ProjectedResidentBytes(line!, 131_072) / GB).toBeCloseTo(62.71, 1);
  });

  it('declines to guess when the catalog has not measured a slope', () => {
    // Without the window the footprint was measured at there is nothing to
    // re-base from, and a confident line drawn through one point is worse
    // than saying nothing.
    expect(ds4ResidentLine({ residentBytes: 36 * GB })).toBeUndefined();
    expect(ds4ResidentLine({ residentBytes: 36 * GB, kvBytesPerToken: 8192 })).toBeUndefined();
    expect(ds4ResidentLine({ kvBytesPerToken: 8192, residentCtxTokens: 131_072 })).toBeUndefined();
  });

  it('clamps a mis-authored slope instead of billing negative memory', () => {
    const line = ds4ResidentLine({
      residentBytes: 1 * GB,
      kvBytesPerToken: 89 * 1024,
      residentCtxTokens: 131_072,
    });
    expect(line?.contextFreeBytes).toBe(0);
    expect(ds4ProjectedResidentBytes(line!, 0)).toBe(0);
  });
});
