import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { PerfSnapshotSchema } from '@bendyline/gezel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BEAT_MS,
  STALL_RECORD_MS,
  WATCHDOG_TICK_MS,
  beginPerfRequest,
  beginPerfWork,
  describeClientReport,
  formatPerfMs,
  isMainThreadBlock,
  perfSnapshot,
  recordClientPerfReport,
  startResponsivenessMonitor,
  workDuring,
} from './responsiveness.js';

vi.mock('node:perf_hooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:perf_hooks')>();
  return { ...actual, monitorEventLoopDelay: vi.fn(actual.monitorEventLoopDelay) };
});

const CAPABILITY = 'Zm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4cXV1eHF1dXg';

function blockFor(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* hold the thread, as a synchronous handler would */
  }
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('stall classification', () => {
  it('blames the main thread only when the watchdog kept time', () => {
    expect(isMainThreadBlock({ startedAt: 0, durationMs: 10_000, watchdogLateMs: 40 })).toBe(true);
    // Host sleep freezes the watchdog too: the suspend clock owns that case.
    expect(isMainThreadBlock({ startedAt: 0, durationMs: 10_000, watchdogLateMs: 9_900 })).toBe(
      false,
    );
  });

  it('ranks the work that fits the block ahead of a long-poll that spanned it', () => {
    const during = workDuring(
      10_000,
      20_000,
      [{ label: 'GET /api/events/long-poll', startedAt: 0 }],
      [
        { label: 'GET /api/config', startedAt: 9_990, endedAt: 20_010 },
        { label: 'GET /api/usage', startedAt: 1_000, endedAt: 2_000 },
      ],
      21_000,
    );
    expect(during.map((w) => w.label)).toEqual(['GET /api/config', 'GET /api/events/long-poll']);
    expect(during[0]?.durationMs).toBe(10_020);
  });

  it('formats durations for log lines', () => {
    expect(formatPerfMs(640)).toBe('640ms');
    expect(formatPerfMs(10_432)).toBe('10.4s');
    expect(formatPerfMs(125_000)).toBe('2m5s');
  });

  it('describes a renderer report in one line', () => {
    expect(
      describeClientReport({
        kind: 'navigation',
        view: 'project:gezel',
        firstFrameMs: 180,
        settledMs: 2_400,
        requests: 23,
        slowest: [
          { method: 'GET', path: '/api/projects/gezel/timeline', ms: 1_100, serverMs: 210 },
        ],
        longTasks: { count: 3, totalMs: 900, maxMs: 640 },
      }),
    ).toBe(
      'opened project:gezel in 2.4s, first frame 180ms, 23 requests, slowest GET /api/projects/gezel/timeline 1.1s (daemon 210ms), renderer busy 3× (max 640ms)',
    );
  });
});

describe('responsiveness monitor', () => {
  let stop: (() => Promise<void>) | null = null;
  let logs: string | null = null;

  afterEach(async () => {
    await stop?.();
    stop = null;
    if (logs) await rm(logs, { recursive: true, force: true });
    logs = null;
  });

  it('is free and empty when not running', () => {
    beginPerfWork('nothing')();
    beginPerfRequest('GET', '/api/health')(200);
    expect(perfSnapshot()).toMatchObject({ running: false, stalls: [], slowRequests: [] });
  });

  it('records a synchronous block with the work that was running', async () => {
    logs = await mkdtemp(join(tmpdir(), 'gezel-perf-'));
    stop = startResponsivenessMonitor({ logsDir: logs });
    await new Promise((r) => setTimeout(r, 300));

    const endRequest = beginPerfRequest('GET', '/api/config');
    blockFor(1_500);
    endRequest(200);

    const stall = await waitFor(() => perfSnapshot().stalls[0]);
    // Measured from the last beat before the block, so never short of it.
    expect(stall.durationMs).toBeGreaterThanOrEqual(1_500);
    expect(stall.during[0]?.label).toBe('GET /api/config');
    expect(perfSnapshot().eventLoopDelay?.maxMs).toBeGreaterThanOrEqual(1_500 - BEAT_MS);
    expect(perfSnapshot().slowRequests[0]).toMatchObject({
      method: 'GET',
      path: '/api/config',
      status: 200,
    });
  });

  it('saves a CPU profile of the block when profiling is on', async () => {
    logs = await mkdtemp(join(tmpdir(), 'gezel-perf-'));
    stop = startResponsivenessMonitor({ logsDir: logs, profileWhen: () => true });
    await waitFor(() => (perfSnapshot().profiling ? true : undefined));

    blockFor(1_200);

    const profile = await waitFor(() => perfSnapshot().stalls[0]?.profile);
    expect(profile).toMatch(/^stall-.*\.cpuprofile$/);
    expect(await readdir(join(logs, 'perf'))).toContain(profile);
  });

  // Every tick wakes an idle machine service. The 20 ms event-loop-delay
  // histogram alone was 50 wakeups a second; now the whole budget is two
  // 250 ms ticks, one per thread, plus the once-a-minute window timer.
  it('stays within its idle wakeup budget', async () => {
    logs = await mkdtemp(join(tmpdir(), 'gezel-perf-'));
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const periods = [WATCHDOG_TICK_MS];
    try {
      stop = startResponsivenessMonitor({ logsDir: logs });
      periods.push(...setIntervalSpy.mock.calls.map((call) => Number(call[1])));
    } finally {
      setIntervalSpy.mockRestore();
    }

    expect(periods).toHaveLength(3);
    expect(monitorEventLoopDelay).not.toHaveBeenCalled();
    expect(Math.min(...periods)).toBeGreaterThanOrEqual(250);
    expect(periods.reduce((sum, ms) => sum + 1_000 / ms, 0)).toBeLessThan(8.1);
    // Coarser than this and a gap can no longer be told from a recordable stall.
    expect(BEAT_MS * 2).toBeLessThanOrEqual(STALL_RECORD_MS);
    expect(WATCHDOG_TICK_MS * 2).toBeLessThanOrEqual(STALL_RECORD_MS);
  });

  it('keeps secrets in request paths out of every label it stores', async () => {
    logs = await mkdtemp(join(tmpdir(), 'gezel-perf-'));
    stop = startResponsivenessMonitor({ logsDir: logs });
    const path = `/preview/${CAPABILITY}/artifacts/proj-1/index.html`;
    const redacted = '/preview/[capability]/artifacts/proj-1/index.html';
    // At the schema's 300-character cap, with a segment shorter than the placeholder.
    const atCap = `/preview/x/${'a'.repeat(289)}`;

    const endRequest = beginPerfRequest('GET', path);
    expect(perfSnapshot().inflight[0]?.label).toBe(`GET ${redacted}`);
    await new Promise((r) => setTimeout(r, 300));
    endRequest(200);
    recordClientPerfReport({
      kind: 'navigation',
      view: 'project:proj-1',
      firstFrameMs: 120,
      settledMs: 1_400,
      requests: 2,
      slowest: [
        { method: 'GET', path, ms: 1_100 },
        { method: 'GET', path: atCap, ms: 900 },
      ],
      longTasks: { count: 0, totalMs: 0, maxMs: 0 },
    });
    recordClientPerfReport({
      kind: 'long-task',
      view: 'project:proj-1',
      durationMs: 640,
      source: `classic-script https://127.0.0.1:6228/preview/${CAPABILITY}/type/proj-1/app.js`,
    });

    // The route validates the stored reports again on the way out.
    const snapshot = PerfSnapshotSchema.parse(perfSnapshot());
    expect(JSON.stringify(snapshot)).not.toContain(CAPABILITY);
    expect(snapshot.slowRequests[0]?.path).toBe(redacted);
    expect(snapshot.clientReports[0]?.report).toMatchObject({
      slowest: [
        { path: redacted },
        { path: expect.stringMatching(/^\/preview\/\[capability\]\/a+$/) },
      ],
    });
  });
});
