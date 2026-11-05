import {
  DS4_FULL_RESIDENCY_HEADROOM_BYTES,
  DS4_FULL_RESIDENCY_RESERVATION_BYTES,
  DS4_RUNTIME_BUFFER_BYTES,
  canUseDs4FullResidency,
  ds4AdmissionGpuBytes,
  ds4BaseResidentBytes,
  ds4ProjectedResidentBytes,
  ds4ResidentBytesForMode,
  ds4ResidentLine,
  ds4VisionResidentBytes,
  planDs4ExpertCache,
  planDs4MeasuredLaunch,
  shouldUseDs4SsdStreaming,
} from '@bendyline/gezel-inference/internal/providers/ds4/residency';
import { describe, expect, it } from 'vitest';

const GB = 1024 ** 3;

describe('DS4 residency policy', () => {
  it('prefers a measured working set over the generic explicit-GGUF multiplier', () => {
    expect(ds4BaseResidentBytes({ projectedBytes: 94 * GB, modelSizeBytes: 90 * GB })).toBe(
      94 * GB,
    );
    expect(ds4BaseResidentBytes({ projectedBytes: 80 * GB, modelSizeBytes: 90 * GB })).toBe(
      90 * GB,
    );
    expect(ds4BaseResidentBytes({ modelSizeBytes: 90 * GB })).toBeCloseTo(99 * GB, -3);
  });

  it('resides by default when the model fits, and streams when it does not', () => {
    // The whole point of the inversion: an 81 GB model on a 128 GB unified
    // machine used to stream (≈10x slower) unless a UI-less config key said
    // otherwise. Nothing is configured here.
    expect(
      shouldUseDs4SsdStreaming({
        modelSizeBytes: 81 * GB,
        totalRamBytes: 128 * GB,
        platform: 'darwin',
        arch: 'arm64',
      }),
    ).toBe(false);
    // Same machine, the mixed-precision build that OOM-killed the engine on a
    // 121.63 GiB Spark: still streams, unconfigured.
    expect(
      shouldUseDs4SsdStreaming({
        modelSizeBytes: 153 * GB,
        totalRamBytes: 128 * GB,
        platform: 'darwin',
        arch: 'arm64',
      }),
    ).toBe(true);
  });

  it('honors an explicit opt-in to streaming even where residency would fit', () => {
    expect(
      shouldUseDs4SsdStreaming({
        configured: true,
        modelSizeBytes: 81 * GB,
        totalRamBytes: 128 * GB,
        platform: 'darwin',
        arch: 'arm64',
      }),
    ).toBe(true);
  });

  it('never emits routed-expert streaming for an architecture that lacks it', () => {
    expect(
      shouldUseDs4SsdStreaming({
        configured: true,
        ssdStreamingSupported: false,
        modelSizeBytes: 42 * GB,
        totalRamBytes: 128 * GB,
        platform: 'darwin',
        arch: 'arm64',
      }),
    ).toBe(false);
  });

  it('prices a DSpark companion into the residency sum', () => {
    const model = Math.round(80.76 * GB);
    const companion = Math.round(5.58 * GB);
    const linuxArm = { platform: 'linux' as const, arch: 'arm64' };
    // On the measured Spark the companion does NOT tip the verdict — 80.76 +
    // 5.58 + 24 = 110.34 against 121.63 — and the observed peak (116.5 GiB)
    // stayed under 121.63. Kept as a regression pin so the accounting change
    // cannot silently start refusing the configuration it was validated on.
    expect(
      canUseDs4FullResidency({
        modelSizeBytes: model,
        totalRamBytes: Math.round(121.63 * GB),
        companionBytes: companion,
        ...linuxArm,
      }),
    ).toBe(true);
    // A slightly smaller host is where ignoring it would have been an OOM:
    // weights alone clear 108 GiB, weights plus companion do not.
    const tight = { modelSizeBytes: model, totalRamBytes: 108 * GB, ...linuxArm };
    expect(canUseDs4FullResidency(tight)).toBe(true);
    expect(canUseDs4FullResidency({ ...tight, companionBytes: companion })).toBe(false);
  });

  it('prices a vision encoder as weights plus a vision compute graph', () => {
    expect(ds4VisionResidentBytes(undefined)).toBe(0);
    expect(ds4VisionResidentBytes(1 * GB)).toBeGreaterThan(1.4 * GB);
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
    expect(DS4_FULL_RESIDENCY_HEADROOM_BYTES).toBe(24 * GB);
    // GLM 5.3 Q2 plus its vision encoder on a 121.63 GiB DGX Spark: the reason
    // the headroom came down from 32 GiB. It runs at a steady 105.2 GiB there.
    expect(
      canUseDs4FullResidency({
        modelSizeBytes: Math.round(89.88 * GB),
        companionBytes: ds4VisionResidentBytes(1_127_280_960),
        totalRamBytes: Math.round(121.63 * GB),
        platform: 'linux',
        arch: 'arm64',
      }),
    ).toBe(true);
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
    ).toEqual({ cacheGb: 32, requestedGb: 32, clamped: false, safe: true, limit: 'headroom' });

    expect(
      planDs4ExpertCache({
        configuredGb: 96,
        catalogCacheBytes: 64 * GB,
        catalogResidentBytes: 80 * GB,
        totalRamBytes: 128 * GB,
      }),
    ).toEqual({ cacheGb: 88, requestedGb: 96, clamped: true, safe: true, limit: 'headroom' });
  });

  it('reserves the broker ceiling for a fully resident model', () => {
    expect(ds4ResidentBytesForMode(36 * GB, true)).toBe(36 * GB);
    expect(ds4ResidentBytesForMode(36 * GB, false)).toBe(DS4_FULL_RESIDENCY_RESERVATION_BYTES);
    expect(ds4ResidentBytesForMode(52 * GB, false, false)).toBe(52 * GB);
  });

  it('admits the wired working set, not the RAM floor, as GPU bytes', () => {
    // deepseek-v4-flash-284b-q2 on a 121.6 GiB DGX Spark: 80.76 GiB of resident
    // weights and a 96 GiB RAM floor. The GPU bytes must also clear the 0.75 x
    // RAM curve a 128 GiB Mac keeps (Linux unified hosts allow RAM - 24 GiB).
    const workingSetBytes = Math.round(80.76 * GB);
    const gpuBytes = ds4AdmissionGpuBytes({
      workingSetBytes,
      reservationBytes: DS4_FULL_RESIDENCY_RESERVATION_BYTES,
      kvBytesPerToken: 8192,
      numCtx: 131_072,
    });
    expect(gpuBytes).toBe(workingSetBytes + 1 * GB + DS4_RUNTIME_BUFFER_BYTES);
    expect(gpuBytes!).toBeLessThan(0.75 * 121.6 * GB);
  });

  it('never quotes GPU bytes above the reservation, and omits them when the floor did not apply', () => {
    expect(
      ds4AdmissionGpuBytes({
        workingSetBytes: 95 * GB,
        reservationBytes: DS4_FULL_RESIDENCY_RESERVATION_BYTES,
        kvBytesPerToken: 8192,
        numCtx: 262_144,
      }),
    ).toBe(DS4_FULL_RESIDENCY_RESERVATION_BYTES);
    expect(
      ds4AdmissionGpuBytes({
        workingSetBytes: 36 * GB,
        reservationBytes: 36 * GB,
        numCtx: 131_072,
      }),
    ).toBeUndefined();
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
  describe('measured launch memory', () => {
    // Shaped like Qwen3.8 Flash Next Q2: ~45 GiB fully loaded at 64K, a
    // ~13 GiB streamed footprint beside an 8 GiB expert cache.
    const source = {
      cacheExpertsBytes: 8 * GB,
      fullResidencyMemory: {
        workingSetBytes: 45 * GB,
        ctxTokens: 65_536,
        bytesPerToken: 36 * 1024,
      },
      streamingMemory: {
        fixedBytes: 13 * GB,
        ctxTokens: 65_536,
        bytesPerToken: 64 * 1024,
        minCacheBytes: 4 * GB,
      },
    };

    it('reserves a measured full residency at its working set, without the 96 GiB floor', () => {
      const plan = planDs4MeasuredLaunch({
        source,
        numCtx: 131_072,
        ssdStreaming: false,
        totalRamBytes: 96 * GB,
        sidecarBytes: 1 * GB,
      });
      const kvAt64k = 36 * 1024 * 65_536;
      expect(plan).toEqual({
        workingSetBytes: 45 * GB + kvAt64k + 1 * GB,
        contextFreeBytes: 45 * GB - kvAt64k + 1 * GB,
        bytesPerToken: 36 * 1024,
      });
      expect(plan!.workingSetBytes).toBeLessThan(DS4_FULL_RESIDENCY_RESERVATION_BYTES);
    });

    it('leaves an unmeasured mode to the catalog path', () => {
      const base = { numCtx: 65_536, totalRamBytes: 64 * GB, budgetBytes: 48 * GB };
      expect(planDs4MeasuredLaunch({ ...base, source: {}, ssdStreaming: false })).toBeUndefined();
      expect(planDs4MeasuredLaunch({ ...base, source: {}, ssdStreaming: true })).toBeUndefined();
      expect(
        planDs4MeasuredLaunch({ ...base, budgetBytes: undefined, source, ssdStreaming: true }),
      ).toBeUndefined();
    });

    it('sizes a measured streamed cache to the device budget instead of the 24 GiB headroom', () => {
      const streamed = (ramGb: number) =>
        planDs4MeasuredLaunch({
          source,
          numCtx: 65_536,
          ssdStreaming: true,
          totalRamBytes: ramGb * GB,
          budgetBytes: 0.75 * ramGb * GB,
          sidecarBytes: 1 * GB,
        });

      // 32 GiB: a 24 GiB budget holds the 14 GiB footprint and the full 8 GiB cache.
      expect(streamed(32)).toEqual({
        workingSetBytes: 22 * GB,
        contextFreeBytes: 14 * GB - 64 * 1024 * 65_536 + 8 * GB,
        bytesPerToken: 64 * 1024,
        cache: { cacheGb: 8, requestedGb: 8, clamped: false, safe: true, limit: 'model-budget' },
      });
      // The generic rule would have refused it outright.
      expect(
        planDs4ExpertCache({
          catalogCacheBytes: 8 * GB,
          catalogResidentBytes: 22 * GB,
          totalRamBytes: 32 * GB,
        }).safe,
      ).toBe(false);
      // 24 GiB: 18 GiB of budget leaves exactly the 4 GiB minimum.
      expect(streamed(24)?.cache).toEqual({
        cacheGb: 4,
        requestedGb: 8,
        clamped: true,
        safe: true,
        limit: 'model-budget',
      });
      // 16 GiB: below the entry's minimum cache, so it needs more memory.
      expect(streamed(16)?.cache?.safe).toBe(false);
    });
  });
});
