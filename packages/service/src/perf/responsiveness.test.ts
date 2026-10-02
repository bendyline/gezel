import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  beginPerfRequest,
  beginPerfWork,
  describeClientReport,
  formatPerfMs,
  isMainThreadBlock,
  perfSnapshot,
  startResponsivenessMonitor,
  workDuring,
} from './responsiveness.js';

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
    expect(stall.durationMs).toBeGreaterThanOrEqual(1_000);
    expect(stall.during[0]?.label).toBe('GET /api/config');
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
});
