import type { SessionTelemetry } from '@bendyline/gezel';
import type { GezelClient } from '@bendyline/gezel-client/node';
import { describe, expect, it, vi } from 'vitest';
import {
  type DaemonActivityCounters,
  type ProgressFingerprint,
  captureFingerprint,
  digestFingerprint,
  parseDaemonActivityText,
  rejectedFileMutationsBySession,
  telemetryToActivityCounters,
} from './progress-fingerprint.ts';

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

  // Real lines from gemma4-31b-q4 (2026-07-30), the two trials that
  // false-failed `chat-stalled` on a live engine. Neither phase is visible to
  // any other soft signal: this build emits no `slot update_slots:` at all,
  // and `stream-active` logged NOTHING across the 301 s decode window.
  it('tracks prefill batches so a slow prefill is not read as a dead engine', () => {
    const early = parseDaemonActivityText(`
2026-07-30T08:12:09.000Z INFO  [chat] [llama-server] 0.33.762.681 I slot print_timing: id  0 | task 1 | prompt processing, n_tokens =   6144, progress = 0.14, t =  29.76 s / 206.46 tokens per second
2026-07-30T08:12:21.000Z INFO  [chat] [llama-server] 0.45.425.546 I slot print_timing: id  0 | task 1 | prompt processing, n_tokens =   8192, progress = 0.19, t =  41.42 s / 197.77 tokens per second
`);
    expect(early.slotUpdates).toBe(0);
    expect(early.streamPulses).toBe(0);
    expect(early.engineProgressMarker).toContain('n_tokens =   8192');

    const later = parseDaemonActivityText(`
2026-07-30T08:17:03.000Z INFO  [chat] [llama-server] 5.33.604.273 I slot print_timing: id  0 | task 1 | prompt processing, n_tokens =  42712, progress = 0.99, t = 329.60 s / 129.59 tokens per second
`);
    expect(later.engineProgressMarker).not.toBe(early.engineProgressMarker);
  });

  // The half the prefill-only marker missed: 10,783 tokens generated at
  // 21 t/s across the whole soft window, with zero stream-active pulses.
  it('tracks decode progress so reasoning-heavy generation is not read as a stall', () => {
    const a = parseDaemonActivityText(
      '2026-07-30T09:03:45.000Z INFO  [chat] [llama-server] 13.22.171.765 I slot print_timing: id  0 | task 424 | n_decoded =  10417, tg =  21.34 t/s, tg_3s =  17.38 t/s',
    );
    const b = parseDaemonActivityText(
      '2026-07-30T09:08:43.000Z INFO  [chat] [llama-server] 13.43.311.705 I slot print_timing: id  0 | task 424 | n_decoded =  10783, tg =  21.17 t/s, tg_3s =  17.52 t/s',
    );
    expect(a.streamPulses).toBe(0);
    expect(a.engineProgressMarker).toContain('n_decoded =  10417');
    expect(b.engineProgressMarker).not.toBe(a.engineProgressMarker);
  });

  it('reports no engine marker when the tail has no timing line', () => {
    expect(parseDaemonActivityText('nothing relevant here').engineProgressMarker).toBeNull();
  });

  // Counters restart per task, so the task id must be part of the marker or
  // two tasks reporting identical numbers would look like a frozen engine.
  it('distinguishes identical counters reported by different tasks', () => {
    const a = parseDaemonActivityText(
      'slot print_timing: id  0 | task 1 | n_decoded =  2048, tg =  20.00 t/s',
    );
    const b = parseDaemonActivityText(
      'slot print_timing: id  0 | task 2 | n_decoded =  2048, tg =  20.00 t/s',
    );
    expect(a.engineProgressMarker).not.toBe(b.engineProgressMarker);
  });
});

describe('telemetryToActivityCounters', () => {
  const session = (over: Partial<SessionTelemetry>): SessionTelemetry => ({
    sessionId: 's1',
    gezelId: 'g1',
    projectId: 'p1',
    inflight: false,
    turnsStarted: 0,
    providerRequestsStarted: 0,
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
        turnsStarted: 2,
        generationSpurts: 200,
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
        turnsStarted: 1,
        generationSpurts: 100,
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

  // INCIDENT (craftbook-spreadsheet-model, 2026-09-30): three edits refused
  // with `stale_task_step` — nothing reached the workspace — read as
  // "3 re-writes without sniff movement" and fired the retry-loop FAST path.
  it('does not count a write the daemon rejected as a mutation', () => {
    const counters = telemetryToActivityCounters(
      [
        session({ sessionId: 'build-1', toolCalls: 15, fileMutations: 2 }),
        session({ sessionId: 'build-2', toolCalls: 11, fileMutations: 2 }),
      ],
      new Map([
        ['build-1', 1],
        ['build-2', 2],
      ]),
    );
    expect(counters.writeCalls).toBe(1);
    // Tool calls still count as activity; only the write classification moves.
    expect(counters.toolCalls).toBe(26);
  });

  it('never lets a session go below zero writes', () => {
    const counters = telemetryToActivityCounters(
      [session({ sessionId: 's1', fileMutations: 1 })],
      new Map([['s1', 4]]),
    );
    expect(counters.writeCalls).toBe(0);
  });
});

describe('rejectedFileMutationsBySession', () => {
  let seq = 0;
  const toolCalled = (details: Record<string, unknown>) => ({
    id: `ev-${++seq}`,
    entryType: 'event',
    kind: 'tool.called',
    details,
  });

  it('counts only failed file-mutation calls, per session', () => {
    const rejected = rejectedFileMutationsBySession([
      toolCalled({ name: 'write_file', sessionId: 'a', success: true }),
      toolCalled({
        name: 'replace_in_file',
        sessionId: 'a',
        success: false,
        errorMessage: '[stale_task_step] Step "build" no longer owns project writes.',
      }),
      toolCalled({ name: 'write_file', sessionId: 'b', success: false }),
      toolCalled({ name: 'write_file', sessionId: 'b', errorMessage: 'ERROR: path denied' }),
      // A failed READ is not a rejected write.
      toolCalled({ name: 'read_file', sessionId: 'a', success: false }),
      // Other event kinds and session entries are ignored.
      { entryType: 'event', kind: 'project.updated', details: { sessionId: 'a' } },
      { entryType: 'session', id: 'a' },
    ]);
    expect(Object.fromEntries(rejected)).toEqual({ a: 1, b: 2 });
  });

  it('counts one event once however often it is read', () => {
    const refused = toolCalled({ name: 'write_file', sessionId: 'a', success: false });
    expect(Object.fromEntries(rejectedFileMutationsBySession([refused, refused]))).toEqual({
      a: 1,
    });
  });
});

describe('captureFingerprint — write accounting', () => {
  const telemetryRow = (fileMutations: number): SessionTelemetry =>
    ({
      sessionId: 'build-1',
      gezelId: 'malai',
      projectId: 'p1',
      inflight: false,
      turnsStarted: 1,
      providerRequestsStarted: 1,
      deltaChunks: 0,
      streamedContentChars: 0,
      wirePulses: 0,
      heartbeats: 0,
      enginePhaseEvents: 0,
      generationSpurts: 0,
      toolCalls: fileMutations,
      toolArgChars: 0,
      fileMutations,
      gpuEvents: 0,
      gpuTaskActive: null,
      lastStreamActivityAt: null,
      lastToolActivityAt: null,
      lastMutationAt: null,
      lastGpuActivityAt: null,
      lastProgressAt: null,
      currentTurn: null,
    }) as SessionTelemetry;

  function client(fileMutations: () => number, entries: () => object[]) {
    return {
      listProjects: vi.fn().mockResolvedValue({ projects: [] }),
      listChatSessions: vi.fn().mockResolvedValue({ sessions: [] }),
      listSessionTelemetry: vi.fn(async () => ({ sessions: [telemetryRow(fileMutations())] })),
      listHistory: vi.fn(async () => ({ entries: entries() })),
    };
  }

  it('subtracts rejected writes the history log reports', async () => {
    const c = client(
      () => 3,
      () => [
        {
          entryType: 'event',
          kind: 'tool.called',
          details: { name: 'write_file', sessionId: 'build-1', success: true },
        },
        {
          entryType: 'event',
          kind: 'tool.called',
          details: { name: 'replace_in_file', sessionId: 'build-1', success: false },
        },
        {
          entryType: 'event',
          kind: 'tool.called',
          details: { name: 'write_file', sessionId: 'build-1', success: false },
        },
      ],
    );
    const fp = await captureFingerprint(c as unknown as GezelClient, 'meester', null);
    expect(fp.daemonActivity?.writeCalls).toBe(1);
    expect(c.listHistory).toHaveBeenCalledWith({ kind: 'tool.called', limit: 2000 });
  });

  // The history route answers only the newest N events, so an old refusal
  // ages out of later reads. It must stay subtracted, or the write count
  // jumps up with no write having happened.
  it('keeps counting a rejection that aged out of the history window', async () => {
    let mutations = 1;
    let entries: object[] = [
      {
        id: 'ev-1',
        entryType: 'event',
        kind: 'tool.called',
        details: { name: 'write_file', sessionId: 'build-1', success: false },
      },
    ];
    const c = client(
      () => mutations,
      () => entries,
    );
    const first = await captureFingerprint(c as unknown as GezelClient, 'meester', null);
    expect(first.daemonActivity?.writeCalls).toBe(0);
    mutations = 2;
    entries = [
      {
        id: 'ev-2',
        entryType: 'event',
        kind: 'tool.called',
        details: { name: 'write_file', sessionId: 'build-1', success: true },
      },
    ];
    const second = await captureFingerprint(c as unknown as GezelClient, 'meester', null);
    expect(second.daemonActivity?.writeCalls).toBe(1);
  });

  // The daemon bumps telemetry a moment before it appends the history
  // event, so a new count is re-read once before it is trusted.
  it('re-reads a new count once, then serves it from cache', async () => {
    let entries: object[] = [];
    const c = client(
      () => 1,
      () => entries,
    );
    const first = await captureFingerprint(c as unknown as GezelClient, 'meester', null);
    expect(first.daemonActivity?.writeCalls).toBe(1);
    entries = [
      {
        entryType: 'event',
        kind: 'tool.called',
        details: { name: 'write_file', sessionId: 'build-1', success: false },
      },
    ];
    const second = await captureFingerprint(c as unknown as GezelClient, 'meester', null);
    expect(second.daemonActivity?.writeCalls).toBe(0);
    await captureFingerprint(c as unknown as GezelClient, 'meester', null);
    expect(c.listHistory).toHaveBeenCalledTimes(2);
  });

  it('falls back to the attempt count when the history read fails', async () => {
    const c = client(
      () => 2,
      () => [],
    );
    c.listHistory.mockRejectedValue(new Error('boom'));
    const fp = await captureFingerprint(c as unknown as GezelClient, 'meester', null);
    expect(fp.daemonActivity?.writeCalls).toBe(2);
  });
});

describe('digestFingerprint — engine heartbeat', () => {
  const activity = (over: Partial<DaemonActivityCounters>): DaemonActivityCounters => ({
    turnStarts: 1,
    toolCalls: 0,
    writeCalls: 0,
    slotUpdates: 0,
    streamPulses: 0,
    imageLogLines: 0,
    imageGenerationActive: false,
    engineProgressMarker: null,
    source: 'service-telemetry',
    ...over,
  });
  const fp = (daemonActivity: DaemonActivityCounters): ProgressFingerprint => ({
    workspace: {},
    sessionCount: 1,
    maxSessionActivityMs: 1000,
    daemonActivity,
    sniffState: null,
  });

  // The regression this guards: with every other counter flat mid-prefill,
  // the soft digest froze and the watchdog killed a working engine.
  it('moves the soft digest as the engine advances, leaving hard flat', () => {
    const a = digestFingerprint(
      fp(activity({ engineProgressMarker: '1|prompt processing, n_tokens = 6144' })),
    );
    const b = digestFingerprint(
      fp(activity({ engineProgressMarker: '1|prompt processing, n_tokens = 42712' })),
    );

    expect(b.soft).not.toBe(a.soft);
    // Prefill is engine-alive, NOT product progress — the hard watchdog must
    // still be able to catch a model that prefills forever and delivers nothing.
    expect(b.hard).toBe(a.hard);
  });

  it('leaves the soft digest frozen once the engine stops advancing', () => {
    const a = digestFingerprint(
      fp(activity({ engineProgressMarker: '1|prompt processing, n_tokens = 42712' })),
    );
    const b = digestFingerprint(
      fp(activity({ engineProgressMarker: '1|prompt processing, n_tokens = 42712' })),
    );
    expect(b.soft).toBe(a.soft);
  });
});

describe('digestFingerprint — deliverable digest', () => {
  const base = (over: Partial<ProgressFingerprint> = {}): ProgressFingerprint => ({
    workspace: {},
    sessionCount: 1,
    maxSessionActivityMs: 1000,
    daemonActivity: {
      turnStarts: 1,
      toolCalls: 3,
      writeCalls: 0,
      slotUpdates: 0,
      streamPulses: 0,
      imageLogLines: 0,
      imageGenerationActive: false,
      engineProgressMarker: null,
      source: 'service-telemetry',
    },
    sniffState: { key: 'craftbook-invoice-run', score: 2, bytes: 0 },
    ...over,
  });

  // A Meester check-in every few minutes kept a dead task "progressing" to
  // the 100-minute cap: tool calls and fresh sessions move the hard digest,
  // and must leave this one alone.
  it('ignores tool-call and session churn', () => {
    const a = digestFingerprint(base());
    const b = digestFingerprint(
      base({
        sessionCount: 34,
        daemonActivity: { ...base().daemonActivity!, toolCalls: 300 },
      }),
    );
    expect(b.hard).not.toBe(a.hard);
    expect(b.deliverable).toBe(a.deliverable);
  });

  it('moves when the sniff verdict or the workspace moves', () => {
    const a = digestFingerprint(base());
    const sniffMoved = digestFingerprint(
      base({ sniffState: { key: 'craftbook-invoice-run', score: 3, bytes: 0 } }),
    );
    expect(sniffMoved.deliverable).not.toBe(a.deliverable);
    const workspaceMoved = digestFingerprint(
      base({
        workspace: {
          p1: { fileCount: 1, pathsHash: 'abc', totalBytes: 945, maxMtimeMs: 1 } as never,
        },
      }),
    );
    expect(workspaceMoved.deliverable).not.toBe(a.deliverable);
  });
});
