/**
 * What the perf suite reads from the page. Navigation timing comes from the
 * app's own `nav-timing.ts` reports, captured as the renderer posts them to
 * `/api/system/perf/client` (the suite turns on report-all, so fast moves are
 * posted too). Frame cost comes from Chromium's long-animation-frame entries
 * and a requestAnimationFrame clock; idle cost from the renderer's CPU time.
 */
import type { ClientPerfReport } from '@bendyline/gezel';
import type { BrowserContext, CDPSession, Page } from '@playwright/test';

export type NavigationReport = Extract<ClientPerfReport, { kind: 'navigation' }>;

/** Marks recorded when a selector first matches, in ms since the page's time origin. */
export const MARKS = {
  homeWorkshop: '[data-testid="home-workshop"]',
  composerEditable: '[data-testid="chat-composer"] [contenteditable="true"]',
} as const;

export async function installPageProbes(context: BrowserContext): Promise<void> {
  await context.addInitScript((marks: Record<string, string>) => {
    try {
      window.localStorage.setItem('gezel:perf:report-all', '1');
    } catch {
      /* storage blocked — only slow navigations will be reported */
    }
    const state = {
      loaf: [] as { start: number; duration: number; blocking: number }[],
      marks: {} as Record<string, number>,
      shifts: [] as { at: number; value: number; nodes: string[] }[],
    };
    (window as unknown as { __gezelPerf: typeof state }).__gezelPerf = state;
    const describe = (node: Node | null | undefined): string => {
      if (!node || !(node instanceof Element)) return node?.nodeName ?? '?';
      const testId = node.getAttribute('data-testid');
      const classes = [...node.classList].slice(0, 3).join('.');
      return `${node.tagName.toLowerCase()}${testId ? `[${testId}]` : ''}${classes ? `.${classes}` : ''}`;
    };
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const shift = entry as PerformanceEntry & {
            value: number;
            sources?: {
              node?: Node | null;
              previousRect: DOMRectReadOnly;
              currentRect: DOMRectReadOnly;
            }[];
          };
          const r = (rect: DOMRectReadOnly) =>
            `${Math.round(rect.x)},${Math.round(rect.y)} ${Math.round(rect.width)}x${Math.round(rect.height)}`;
          state.shifts.push({
            at: entry.startTime,
            value: shift.value,
            nodes: (shift.sources ?? []).map(
              (source) =>
                `${describe(source.node)} (${r(source.previousRect)} -> ${r(source.currentRect)})`,
            ),
          });
        }
      }).observe({ type: 'layout-shift', buffered: true });
    } catch {
      /* not Chromium */
    }
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          state.loaf.push({
            start: entry.startTime,
            duration: entry.duration,
            blocking:
              (entry as PerformanceEntry & { blockingDuration?: number }).blockingDuration ?? 0,
          });
        }
      }).observe({ type: 'long-animation-frame', buffered: true });
    } catch {
      /* not Chromium */
    }
    const pending = new Map(Object.entries(marks));
    const check = () => {
      for (const [name, selector] of pending) {
        if (document.querySelector(selector)) {
          state.marks[name] = performance.now();
          pending.delete(name);
        }
      }
      if (pending.size === 0) observer.disconnect();
    };
    const observer = new MutationObserver(check);
    const start = () => {
      observer.observe(document.documentElement, { childList: true, subtree: true });
      check();
    };
    if (document.documentElement) start();
    else document.addEventListener('DOMContentLoaded', start);
  }, MARKS);
}

/** Collect the navigation reports the page posts, in arrival order. */
export function collectNavigationReports(page: Page): NavigationReport[] {
  const reports: NavigationReport[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'POST') return;
    if (!new URL(request.url()).pathname.endsWith('/api/system/perf/client')) return;
    try {
      const report = request.postDataJSON() as ClientPerfReport;
      if (report?.kind === 'navigation') reports.push(report);
    } catch {
      /* not JSON */
    }
  });
  return reports;
}

/** Run `act` and return the first navigation report that arrives after it. */
export async function timedMove(
  page: Page,
  reports: NavigationReport[],
  act: () => Promise<void>,
  timeoutMs = 30_000,
): Promise<NavigationReport | null> {
  const before = reports.length;
  await act();
  const deadline = Date.now() + timeoutMs;
  while (reports.length <= before) {
    if (Date.now() > deadline) return null;
    await page.waitForTimeout(50);
  }
  // Let anything the move set off finish before the next move starts.
  await page.waitForTimeout(400);
  return reports[before] ?? null;
}

/** The elements that moved most since `since` (page time), with their summed shift. */
export async function topShifts(
  page: Page,
  since: number,
): Promise<{ node: string; value: number }[]> {
  return page.evaluate((from) => {
    const totals = new Map<string, number>();
    const shifts = (
      window as unknown as {
        __gezelPerf: { shifts: { at: number; value: number; nodes: string[] }[] };
      }
    ).__gezelPerf.shifts;
    for (const shift of shifts) {
      if (shift.at < from) continue;
      for (const node of shift.nodes) totals.set(node, (totals.get(node) ?? 0) + shift.value);
    }
    return [...totals]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([node, value]) => ({ node, value: Math.round(value * 1000) / 1000 }));
  }, since);
}

export async function pageNow(page: Page): Promise<number> {
  return page.evaluate(() => performance.now());
}

export async function readMarks(page: Page): Promise<Record<string, number>> {
  return page.evaluate(
    () =>
      (window as unknown as { __gezelPerf: { marks: Record<string, number> } }).__gezelPerf.marks,
  );
}

export interface FrameStats {
  frames: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  /** Frames longer than two vsyncs at 60 Hz: visible stutter. */
  over33Ms: number;
  longFrames: number;
  longFrameTotalMs: number;
  longFrameMaxMs: number;
}

/** Start a requestAnimationFrame clock and long-frame window; the returned function stops both. */
export async function startFrameClock(page: Page): Promise<() => Promise<FrameStats>> {
  await page.evaluate(() => {
    const w = window as unknown as {
      __gezelFrames?: { deltas: number[]; running: boolean; since: number };
      __gezelPerf: { loaf: { start: number; duration: number }[] };
    };
    const clock = { deltas: [] as number[], running: true, since: performance.now() };
    w.__gezelFrames = clock;
    let last = performance.now();
    const tick = (now: number) => {
      if (!clock.running) return;
      clock.deltas.push(now - last);
      last = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  return async () =>
    page.evaluate(() => {
      const w = window as unknown as {
        __gezelFrames: { deltas: number[]; running: boolean; since: number };
        __gezelPerf: { loaf: { start: number; duration: number }[] };
      };
      const clock = w.__gezelFrames;
      clock.running = false;
      const sorted = [...clock.deltas].sort((a, b) => a - b);
      const at = (q: number) =>
        sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
      const loaf = w.__gezelPerf.loaf.filter((entry) => entry.start >= clock.since);
      const round = (n: number) => Math.round(n * 10) / 10;
      return {
        frames: sorted.length,
        p50Ms: round(at(0.5)),
        p95Ms: round(at(0.95)),
        maxMs: round(sorted.at(-1) ?? 0),
        over33Ms: sorted.filter((d) => d > 33.4).length,
        longFrames: loaf.length,
        longFrameTotalMs: Math.round(loaf.reduce((sum, entry) => sum + entry.duration, 0)),
        longFrameMaxMs: Math.round(Math.max(0, ...loaf.map((entry) => entry.duration))),
      };
    });
}

interface ProfileNode {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number };
  children?: number[];
}

/**
 * Start a renderer CPU profile; the returned function saves it (open it in
 * Chrome DevTools) and summarizes self time by script and function. Minified
 * names are kept with their position so the source map can resolve them.
 */
export async function startProfile(
  page: Page,
): Promise<
  (path: string) => Promise<{ totalMs: number; top: { where: string; selfMs: number }[] }>
> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
  await cdp.send('Profiler.start');
  return async (path) => {
    const { profile } = (await cdp.send('Profiler.stop')) as {
      profile: {
        nodes: ProfileNode[];
        samples: number[];
        timeDeltas: number[];
      };
    };
    await cdp.detach();
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, JSON.stringify(profile));
    const byId = new Map(profile.nodes.map((node) => [node.id, node]));
    const self = new Map<string, number>();
    let total = 0;
    profile.samples.forEach((id, index) => {
      const ms = (profile.timeDeltas[index] ?? 0) / 1000;
      total += ms;
      const frame = byId.get(id)?.callFrame;
      if (!frame) return;
      const file = frame.url ? frame.url.split('/').pop() : '(native)';
      const where = `${frame.functionName || '(anonymous)'} ${file}:${frame.lineNumber + 1}:${frame.columnNumber + 1}`;
      self.set(where, (self.get(where) ?? 0) + ms);
    });
    return {
      totalMs: Math.round(total),
      top: [...self]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 25)
        .map(([where, ms]) => ({ where, selfMs: Math.round(ms) })),
    };
  };
}

interface TraceEvent {
  name: string;
  ph: string;
  dur?: number;
  tid: number;
  pid: number;
  args?: {
    name?: string;
    elementCount?: number;
    beginData?: { stackTrace?: unknown[] };
    data?: {
      nodeName?: string;
      reason?: string;
      changedClass?: string;
      changedAttribute?: string;
      changedPseudo?: string;
      changedId?: string;
      invalidationList?: { classes?: string[]; attributes?: string[]; tagNames?: string[] }[];
    };
  };
}

export interface TraceSummary {
  windowMs: number;
  /** Main-thread time by trace event name (Layout, UpdateLayoutTree = style, Paint…). */
  byName: { name: string; ms: number; count: number }[];
  /** Layouts and style recalcs JavaScript forced by reading geometry mid-frame. */
  forcedLayouts: number;
  forcedStyles: number;
  /** Elements restyled per style recalc, on average and at most: whole-tree invalidation shows here. */
  styledElements: { average: number; max: number };
  /** What invalidated style most often: the change and the node it landed on. */
  invalidations: { what: string; count: number }[];
}

/**
 * Trace the renderer's main thread for `ms` and say where its time went:
 * style, layout, paint or script, and how many layouts JavaScript forced.
 */
export async function traceMainThread(page: Page, ms: number): Promise<TraceSummary> {
  const cdp = await page.context().newCDPSession(page);
  const events: TraceEvent[] = [];
  cdp.on('Tracing.dataCollected', (data) => {
    events.push(...(data.value as unknown as TraceEvent[]));
  });
  const complete = new Promise<void>((resolve) =>
    cdp.once('Tracing.tracingComplete', () => resolve()),
  );
  await cdp.send('Tracing.start', {
    transferMode: 'ReportEvents',
    traceConfig: {
      includedCategories: [
        'devtools.timeline',
        'disabled-by-default-devtools.timeline',
        'disabled-by-default-devtools.timeline.invalidationTracking',
      ],
    },
  });
  await page.waitForTimeout(ms);
  await cdp.send('Tracing.end');
  await complete;
  await cdp.detach();
  const main = events.find(
    (event) =>
      event.ph === 'M' && event.name === 'thread_name' && event.args?.name === 'CrRendererMain',
  );
  const onMain = events.filter(
    (event) => main && event.pid === main.pid && event.tid === main.tid && event.ph === 'X',
  );
  const totals = new Map<string, { ms: number; count: number }>();
  let forcedLayouts = 0;
  let forcedStyles = 0;
  const styled = onMain
    .filter(
      (event) => event.name === 'UpdateLayoutTree' && typeof event.args?.elementCount === 'number',
    )
    .map((event) => event.args!.elementCount!);
  const invalidations = new Map<string, number>();
  for (const event of events) {
    if (main && (event.pid !== main.pid || event.tid !== main.tid)) continue;
    if (!/InvalidationTracking$/.test(event.name)) continue;
    const data = event.args?.data;
    if (!data) continue;
    const change = data.changedClass
      ? `class .${data.changedClass}`
      : data.changedAttribute
        ? `attr [${data.changedAttribute}]`
        : data.changedPseudo
          ? `pseudo ${data.changedPseudo}`
          : data.changedId
            ? `id #${data.changedId}`
            : (data.reason ?? '?');
    const what = `${event.name.replace('InvalidationTracking', '')}: ${change} on ${data.nodeName ?? '?'}`;
    invalidations.set(what, (invalidations.get(what) ?? 0) + 1);
  }
  for (const event of onMain) {
    const entry = totals.get(event.name) ?? { ms: 0, count: 0 };
    entry.ms += (event.dur ?? 0) / 1000;
    entry.count++;
    totals.set(event.name, entry);
    const forced = (event.args?.beginData?.stackTrace?.length ?? 0) > 0;
    if (forced && event.name === 'Layout') forcedLayouts++;
    if (forced && event.name === 'UpdateLayoutTree') forcedStyles++;
  }
  return {
    windowMs: ms,
    byName: [...totals]
      .map(([name, entry]) => ({ name, ms: Math.round(entry.ms), count: entry.count }))
      .filter((entry) => entry.ms >= 5)
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 14),
    forcedLayouts,
    forcedStyles,
    styledElements: {
      average: styled.length ? Math.round(styled.reduce((a, b) => a + b, 0) / styled.length) : 0,
      max: styled.length ? Math.max(...styled) : 0,
    },
    invalidations: [...invalidations]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([what, count]) => ({ what, count })),
  };
}

/** Renderer main-thread CPU seconds spent over `ms` of doing nothing. */
export async function idleCpu(page: Page, cdp: CDPSession, ms: number): Promise<number> {
  await cdp.send('Performance.enable');
  const read = async () =>
    (await cdp.send('Performance.getMetrics')).metrics.find((m) => m.name === 'TaskDuration')
      ?.value ?? 0;
  const before = await read();
  await page.waitForTimeout(ms);
  return Math.round(((await read()) - before) * 1000) / 1000;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}
