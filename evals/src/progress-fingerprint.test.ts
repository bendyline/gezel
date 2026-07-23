import type { SessionTelemetry } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { parseDaemonActivityText, telemetryToActivityCounters } from './progress-fingerprint.ts';

describe('parseDaemonActivityText', () => {
  it('marks native image generation active until the completion line appears', () => {
    const active = parseDaemonActivityText(`
2026-06-03T23:35:30.711Z DEBUG [mcp-bridge] call_tool generate_image keys=prompt
2026-06-03T23:35:34.892Z INFO  [native] [sd-server] [INFO ] stable-diffusion.cpp:3395 - generate_image 512x512
2026-06-03T23:35:49.659Z INFO  [native] [sd-server] [INFO ] stable-diffusion.cpp:3429 - generating image: 1/1 - seed 42
2026-06-03T23:37:11.236Z INFO  [native] [sd-server]   |============>                                     | 1/4 - 81.53s/it
`);

    expect(active.toolCalls).toBe(1);
    expect(active.imageLogLines).toBeGreaterThan(0);
    expect(active.imageGenerationActive).toBe(true);

    const complete = parseDaemonActivityText(`
2026-06-03T20:14:10.000Z INFO  [native] [sd-server] [INFO ] stable-diffusion.cpp:3395 - generate_image 512x512
2026-06-03T20:22:04.822Z INFO  [native] [sd-server] [INFO ] stable-diffusion.cpp:3615 - generate_image completed in 474.82s
`);

    expect(complete.imageGenerationActive).toBe(false);
  });

  it('counts stream-active pulses from both llama-cpp and mlx (engine-agnostic)', () => {
    const fp = parseDaemonActivityText(`
2026-06-24T15:00:00.000Z INFO  [chat] [llama-cpp] stream-active session=abc chunks=12/total=40
2026-06-24T15:00:05.000Z INFO  [chat] [mlx] stream-active tokens=128 · 22.4 tok/s
2026-06-24T15:00:10.000Z INFO  [chat] [mlx] stream-active tokens=240 · 21.9 tok/s
`);
    // Without the engine-agnostic match the two [mlx] lines were invisible,
    // so a long MLX decode looked like a stall (T2-streaming).
    expect(fp.streamPulses).toBe(3);
    expect(fp.source).toBe('daemon-log');
  });
});

describe('telemetryToActivityCounters', () => {
  const session = (over: Partial<SessionTelemetry>): SessionTelemetry => ({
    sessionId: 's1',
    gezelId: 'g1',
    projectId: 'p1',
    inflight: false,
    turnsStarted: 0,
    deltaChunks: 0,
    streamedContentChars: 0,
    wirePulses: 0,
    heartbeats: 0,
    enginePhaseEvents: 0,
    generationSpurts: 0,
    toolCalls: 0,
    toolArgChars: 0,
    fileMutations: 0,
    gpuEvents: 0,
    gpuTaskActive: null,
    lastStreamActivityAt: null,
    lastToolActivityAt: null,
    lastMutationAt: null,
    lastGpuActivityAt: null,
    lastProgressAt: null,
    currentTurn: null,
    ...over,
  });

  it('sums per-session counters onto the digest counter shape', () => {
    const counters = telemetryToActivityCounters([
      session({
        sessionId: 's1',
        generationSpurts: 2,
        toolCalls: 5,
        fileMutations: 2,
        enginePhaseEvents: 7,
        deltaChunks: 10,
        wirePulses: 3,
        heartbeats: 1,
        gpuEvents: 4,
      }),
      session({
        sessionId: 's2',
        generationSpurts: 1,
        toolCalls: 1,
        fileMutations: 0,
        enginePhaseEvents: 2,
        deltaChunks: 5,
        wirePulses: 0,
        heartbeats: 0,
        gpuEvents: 0,
      }),
    ]);
    expect(counters).toMatchObject({
      turnStarts: 3,
      toolCalls: 6,
      writeCalls: 2,
      slotUpdates: 9,
      streamPulses: 19,
      imageLogLines: 4,
      imageGenerationActive: false,
      source: 'service-telemetry',
    });
  });

  it('flags active image generation when any session has a live gpu task', () => {
    const counters = telemetryToActivityCounters([
      session({ sessionId: 's1' }),
      session({ sessionId: 's2', gpuTaskActive: 'image_generation' }),
    ]);
    expect(counters.imageGenerationActive).toBe(true);
  });

  it('returns a zeroed counter set for no sessions', () => {
    expect(telemetryToActivityCounters([])).toMatchObject({
      turnStarts: 0,
      toolCalls: 0,
      writeCalls: 0,
      imageGenerationActive: false,
      source: 'service-telemetry',
    });
  });
});
