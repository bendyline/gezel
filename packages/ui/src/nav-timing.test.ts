import type { ClientPerfReport } from '@bendyline/gezel';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  asBackground,
  beginNavigation,
  contentShiftValue,
  instrumentFetch,
  parseServerTiming,
  recentPerfReports,
  setPerfReportSink,
  shouldReport,
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

/** Run the fake clock on until `read` returns a value. */
async function waitFor<T>(read: () => T | undefined, timeoutMs = 3_000): Promise<T> {
  for (let waited = 0; ; waited += 25) {
    const value = read();
    if (value !== undefined) return value;
    if (waited > timeoutMs) throw new Error('timed out waiting');
    await vi.advanceTimersByTimeAsync(25);
  }
}

/** Await `promise` while the fake clock runs on, as real time would. */
async function advancing<T>(promise: Promise<T>): Promise<T> {
  let settled = false;
  const done = () => {
    settled = true;
  };
  promise.then(done, done);
  while (!settled) await vi.advanceTimersByTimeAsync(5);
  return promise;
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
  // One fake clock (performance.now and frames included) for the whole block:
  // the module keeps requests and input times between tests, so they must all
  // read one clock that only moves forward.
  beforeAll(() => {
    vi.useFakeTimers();
  });
  afterAll(() => {
    vi.useRealTimers();
  });

  it('hands a slow navigation to the daemon with its slowest request', async () => {
    const sent: ClientPerfReport[] = [];
    setPerfReportSink((r) => sent.push(r));
    const timedFetch = instrumentFetch(fakeFetch(1_050, 'app;dur=31'));

    beginNavigation('area:settings');
    await advancing(timedFetch('/api/config?x=1'));

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
    await advancing(timedFetch('/api/projects/fast'));

    await waitFor(() => (recentPerfReports().length > before ? true : undefined));
    expect(recentPerfReports().at(-1)).toMatchObject({ view: 'project:fast', requests: 1 });
    expect(sent).toEqual([]);
  });

  it('leaves polling out of the view and counts it apart', async () => {
    const timedFetch = instrumentFetch(fakeFetch(5));
    beginNavigation('area:tasks');
    await advancing(asBackground(() => timedFetch('/api/activity')));
    await advancing(timedFetch('/api/tasks'));
    const report = await waitFor(() => {
      const last = recentPerfReports().at(-1);
      return last?.view === 'area:tasks' ? last : undefined;
    });
    expect(report).toMatchObject({ requests: 1, backgroundRequests: 1 });
    if (report.kind !== 'navigation') throw new Error('unexpected kind');
    expect(report.slowest.map((r) => r.path)).toEqual(['/api/tasks']);
  });

  it('charges a move inside a view with requests its tab began since the click', async () => {
    const timedFetch = instrumentFetch(fakeFetch(20));
    window.dispatchEvent(new MouseEvent('click'));
    // The tab mounts and fetches before its parent reports the move.
    const early = timedFetch('/api/projects/p/tasks');
    beginNavigation('project:p/tab:tasks', { scope: 'part' });
    await advancing(early);
    const report = await waitFor(() => {
      const last = recentPerfReports().at(-1);
      return last?.view === 'project:p/tab:tasks' ? last : undefined;
    });
    expect(report).toMatchObject({ scope: 'part', requests: 1 });
  });

  it('folds a move inside a view into the move to that view from the same click', async () => {
    const timedFetch = instrumentFetch(fakeFetch(5));
    window.dispatchEvent(new MouseEvent('click'));
    beginNavigation('project:q');
    beginNavigation('project:q/tab:chat', { scope: 'part' });
    await advancing(timedFetch('/api/projects/q'));
    const report = await waitFor(() => {
      const last = recentPerfReports().at(-1);
      return last?.view.startsWith('project:q') ? last : undefined;
    });
    expect(report.view).toBe('project:q');
  });

  it('waits for the body the view reads before calling it drawn', async () => {
    let resolveBody: (value: unknown) => void = () => {};
    const bodyFetch = (async () => ({
      headers: new Headers(),
      json: () =>
        new Promise((resolve) => {
          resolveBody = resolve;
        }),
    })) as unknown as typeof fetch;
    const timedFetch = instrumentFetch(bodyFetch);
    beginNavigation('area:history');
    const res = await timedFetch('/api/history');
    const body = res.json();
    await vi.advanceTimersByTimeAsync(600);
    expect(recentPerfReports().at(-1)?.view).not.toBe('area:history');
    resolveBody({ entries: [] });
    await body;
    const report = await waitFor(() => {
      const last = recentPerfReports().at(-1);
      return last?.view === 'area:history' ? last : undefined;
    });
    if (report.kind !== 'navigation') throw new Error('unexpected kind');
    expect(report.paintedMs).toBeGreaterThanOrEqual(600);
  });

  it('counts content moving inside a pane but not the shell frame changing mode', () => {
    document.body.innerHTML =
      '<div data-layout-frame="rail"><nav><a id="row">Home</a></nav></div>' +
      '<main data-layout-frame="pane"><section id="card"></section></main>';
    const rail = document.querySelector('[data-layout-frame="rail"]')!;
    const row = document.getElementById('row')!;
    const pane = document.querySelector('main')!;
    const card = document.getElementById('card')!;
    expect(contentShiftValue({ value: 0.7, sources: [{ node: pane }, { node: row }] })).toBe(0);
    expect(contentShiftValue({ value: 0.7, sources: [{ node: rail }] })).toBe(0);
    expect(contentShiftValue({ value: 0.2, sources: [{ node: card }] })).toBe(0.2);
    expect(contentShiftValue({ value: 0.2, sources: [{ node: pane }, { node: card }] })).toBe(0.2);
    expect(contentShiftValue({ value: 0.1 })).toBe(0.1);
    document.body.innerHTML = '';
  });

  it('reports a navigation whose content moved a lot, however fast', () => {
    expect(
      shouldReport({
        kind: 'navigation',
        view: 'home',
        firstFrameMs: 40,
        settledMs: 300,
        paintedMs: 320,
        layoutShift: 0.4,
        requests: 3,
        slowest: [],
        longTasks: { count: 0, totalMs: 0, maxMs: 0 },
      }),
    ).toBe(true);
  });

  it('never times its own reports', async () => {
    const timedFetch = instrumentFetch(fakeFetch(1));
    beginNavigation('home');
    await advancing(timedFetch('/api/system/perf/client', { method: 'POST' }));
    const report = await waitFor(() => {
      const last = recentPerfReports().at(-1);
      return last?.view === 'home' ? last : undefined;
    });
    expect(report).toMatchObject({ requests: 0 });
  });
});
