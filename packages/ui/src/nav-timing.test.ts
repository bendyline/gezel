import type { ClientPerfReport } from '@bendyline/gezel';
import { afterEach, describe, expect, it } from 'vitest';
import {
  beginNavigation,
  instrumentFetch,
  parseServerTiming,
  recentPerfReports,
  setPerfReportSink,
} from './nav-timing.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeFetch(delayMs: number, serverTiming?: string): typeof fetch {
  return (async () => {
    await sleep(delayMs);
    return {
      headers: new Headers(serverTiming ? { 'server-timing': serverTiming } : {}),
    } as Response;
  }) as typeof fetch;
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 3_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await sleep(25);
  }
}

afterEach(() => setPerfReportSink(null));

describe('parseServerTiming', () => {
  it('reads the daemon entry and ignores others', () => {
    expect(parseServerTiming('app;dur=12.6')).toBe(13);
    expect(parseServerTiming('cache;desc=hit, app;dur=250')).toBe(250);
    expect(parseServerTiming('db;dur=40')).toBeUndefined();
    expect(parseServerTiming(null)).toBeUndefined();
  });
});

describe('navigation timing', () => {
  it('hands a slow navigation to the daemon with its slowest request', async () => {
    const sent: ClientPerfReport[] = [];
    setPerfReportSink((r) => sent.push(r));
    const timedFetch = instrumentFetch(fakeFetch(1_050, 'app;dur=31'));

    beginNavigation('area:settings');
    await timedFetch('/api/config?x=1');

    const report = await waitFor(() => sent[0]);
    expect(report).toMatchObject({
      kind: 'navigation',
      view: 'area:settings',
      requests: 1,
      slowest: [{ method: 'GET', path: '/api/config', serverMs: 31 }],
    });
    if (report.kind !== 'navigation') throw new Error('unexpected kind');
    expect(report.settledMs).toBeGreaterThanOrEqual(1_000);
    expect(report.unsettled).toBeUndefined();
  });

  it('keeps a fast navigation local', async () => {
    const sent: ClientPerfReport[] = [];
    setPerfReportSink((r) => sent.push(r));
    const timedFetch = instrumentFetch(fakeFetch(5));
    const before = recentPerfReports().length;

    beginNavigation('project:fast');
    await timedFetch('/api/projects/fast');

    await waitFor(() => (recentPerfReports().length > before ? true : undefined));
    expect(recentPerfReports().at(-1)).toMatchObject({ view: 'project:fast', requests: 1 });
    expect(sent).toEqual([]);
  });

  it('never times its own reports', async () => {
    const timedFetch = instrumentFetch(fakeFetch(1));
    beginNavigation('home');
    await timedFetch('/api/system/perf/client', { method: 'POST' });
    const report = await waitFor(() => {
      const last = recentPerfReports().at(-1);
      return last?.view === 'home' ? last : undefined;
    });
    expect(report).toMatchObject({ requests: 0 });
  });
});
