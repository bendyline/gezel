import {
  type ClientLongTasks,
  type ClientPerfReport,
  type ClientPerfRequest,
  createLogger,
} from '@bendyline/gezel';

/**
 * Renderer-side responsiveness timing: how long a move between views took,
 * from the click to the last response the new view waited on, and when the
 * renderer's own main thread was too busy to paint. The daemon logs what it
 * is handed beside its own stall and slow-request lines, so one log explains
 * a sluggish moment from both ends.
 *
 * Views are not kept alive — every switch remounts and refetches — so the
 * finish line is "settled": the first frame usually shows a placeholder, the
 * last response shows the view.
 */

const log = createLogger('perf');

/** The view has settled once none of its own requests ran for this long. */
const QUIET_MS = 400;
const GIVE_UP_MS = 20_000;
/** Navigations slower than this are handed to the daemon. */
export const REPORT_NAVIGATION_MS = 1_000;
/** ...as are navigations during which the renderer froze for this long. */
const REPORT_NAVIGATION_FRAME_MS = 200;
/** A frozen frame outside any navigation is reported past this. */
const REPORT_LONG_FRAME_MS = 500;
const LONG_FRAME_REPORT_GAP_MS = 5_000;
const RECENT_LIMIT = 30;
const PERF_ENDPOINT_PREFIX = '/api/system/perf';

class Navigation {
  readonly startedAt = performance.now();
  firstFrameMs: number | null = null;
  lastResponseMs = 0;
  pending = 0;
  done = false;
  readonly requests: ClientPerfRequest[] = [];
  readonly longTasks: ClientLongTasks = { count: 0, totalMs: 0, maxMs: 0 };
  private quietTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly giveUpTimer: ReturnType<typeof setTimeout>;

  constructor(
    readonly view: string,
    private readonly finish: (nav: Navigation, unsettled: boolean) => void,
  ) {
    // After the next paint: a frame callback runs before paint, the timeout after it.
    requestAnimationFrame(() => {
      setTimeout(() => {
        if (this.done) return;
        this.firstFrameMs = performance.now() - this.startedAt;
        this.checkQuiet();
      }, 0);
    });
    this.giveUpTimer = setTimeout(() => this.finish(this, true), GIVE_UP_MS);
  }

  requestStarted(): void {
    this.pending++;
    this.clearQuiet();
  }

  requestEnded(request: ClientPerfRequest): void {
    if (this.done) return;
    this.pending = Math.max(0, this.pending - 1);
    this.requests.push(request);
    this.lastResponseMs = performance.now() - this.startedAt;
    this.checkQuiet();
  }

  longFrame(durationMs: number): void {
    this.longTasks.count++;
    this.longTasks.totalMs += durationMs;
    this.longTasks.maxMs = Math.max(this.longTasks.maxMs, durationMs);
  }

  close(): void {
    this.done = true;
    this.clearQuiet();
    clearTimeout(this.giveUpTimer);
  }

  private checkQuiet(): void {
    if (this.done || this.firstFrameMs === null || this.pending > 0) return;
    this.clearQuiet();
    this.quietTimer = setTimeout(() => this.finish(this, false), QUIET_MS);
  }

  private clearQuiet(): void {
    if (this.quietTimer !== null) clearTimeout(this.quietTimer);
    this.quietTimer = null;
  }
}

let current: Navigation | null = null;
let currentView = 'home';
let sink: ((report: ClientPerfReport) => void) | null = null;
let lastLongFrameReportAt = 0;
let observing = false;
const recent: ClientPerfReport[] = [];

/** Where reports worth the daemon's attention go. */
export function setPerfReportSink(fn: ((report: ClientPerfReport) => void) | null): void {
  sink = fn;
}

/** Start timing a move to `view`. A navigation still loading is abandoned. */
export function beginNavigation(view: string): void {
  ensureLongFrameObserver();
  if (current) {
    const elapsed = performance.now() - current.startedAt;
    const previous = current;
    current = null;
    if (elapsed >= REPORT_NAVIGATION_MS) publish(toReport(previous, true, elapsed));
    previous.close();
  }
  currentView = view;
  current = new Navigation(view, (nav, unsettled) => {
    if (current === nav) current = null;
    nav.close();
    publish(toReport(nav, unsettled, performance.now() - nav.startedAt));
  });
}

/** Wrap the API client's fetch so each request is charged to the navigation that issued it. */
export function instrumentFetch(base: typeof fetch): typeof fetch {
  ensureLongFrameObserver();
  return async (input, init) => {
    const path = pathOf(input);
    if (path.startsWith(PERF_ENDPOINT_PREFIX)) return base(input, init);
    const method = (
      init?.method ??
      (typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET')
    ).toUpperCase();
    const nav = current;
    nav?.requestStarted();
    const started = performance.now();
    let serverMs: number | undefined;
    try {
      const res = await base(input, init);
      serverMs = parseServerTiming(res.headers.get('server-timing'));
      return res;
    } finally {
      nav?.requestEnded({
        method,
        path,
        ms: Math.round(performance.now() - started),
        ...(serverMs !== undefined ? { serverMs } : {}),
      });
    }
  };
}

/** The last reports, newest last — for tests and a future Settings panel. */
export function recentPerfReports(): ClientPerfReport[] {
  return [...recent];
}

export function parseServerTiming(header: string | null): number | undefined {
  const match = header ? /(?:^|,)\s*app;dur=([\d.]+)/.exec(header) : null;
  return match ? Math.round(Number(match[1])) : undefined;
}

export function shouldReport(report: ClientPerfReport): boolean {
  if (report.kind === 'long-task') return true;
  return (
    report.settledMs >= REPORT_NAVIGATION_MS || report.longTasks.maxMs >= REPORT_NAVIGATION_FRAME_MS
  );
}

function toReport(nav: Navigation, unsettled: boolean, elapsedMs: number): ClientPerfReport {
  const firstFrameMs = nav.firstFrameMs ?? elapsedMs;
  return {
    kind: 'navigation',
    view: nav.view,
    firstFrameMs: Math.round(firstFrameMs),
    settledMs: Math.round(unsettled ? elapsedMs : Math.max(firstFrameMs, nav.lastResponseMs)),
    ...(unsettled ? { unsettled: true } : {}),
    requests: nav.requests.length,
    slowest: [...nav.requests].sort((a, b) => b.ms - a.ms).slice(0, 5),
    longTasks: {
      count: nav.longTasks.count,
      totalMs: Math.round(nav.longTasks.totalMs),
      maxMs: Math.round(nav.longTasks.maxMs),
    },
  };
}

function publish(report: ClientPerfReport): void {
  recent.push(report);
  if (recent.length > RECENT_LIMIT) recent.splice(0, recent.length - RECENT_LIMIT);
  if (!shouldReport(report)) {
    if (report.kind === 'navigation') {
      log.debug(`${report.view} settled in ${report.settledMs}ms (${report.requests} requests)`);
    }
    return;
  }
  try {
    sink?.(report);
  } catch {
    /* reporting must never break the view */
  }
}

function onLongFrame(durationMs: number, source: string | undefined): void {
  if (current) {
    current.longFrame(durationMs);
    return;
  }
  if (durationMs < REPORT_LONG_FRAME_MS) return;
  const now = performance.now();
  if (now - lastLongFrameReportAt < LONG_FRAME_REPORT_GAP_MS) return;
  lastLongFrameReportAt = now;
  publish({
    kind: 'long-task',
    view: currentView,
    durationMs: Math.round(durationMs),
    ...(source ? { source } : {}),
  });
}

interface LongFrameScript {
  duration?: number;
  invoker?: string;
  sourceURL?: string;
  sourceFunctionName?: string;
  sourceCharPosition?: number;
}

/** Chromium's long-animation-frame entries name the script that held the frame. */
function frameSource(entry: PerformanceEntry): string | undefined {
  const scripts = (entry as PerformanceEntry & { scripts?: LongFrameScript[] }).scripts;
  if (!scripts || scripts.length === 0) return undefined;
  const top = scripts.reduce((a, b) => ((b.duration ?? 0) > (a.duration ?? 0) ? b : a));
  const file = top.sourceURL ? top.sourceURL.split('/').pop() : undefined;
  const text = [
    top.invoker,
    top.sourceFunctionName ? `${top.sourceFunctionName}()` : undefined,
    file ? `${file}:${top.sourceCharPosition ?? 0}` : undefined,
  ]
    .filter(Boolean)
    .join(' ');
  return text ? text.slice(0, 300) : undefined;
}

function ensureLongFrameObserver(): void {
  if (observing) return;
  observing = true;
  const Observer = globalThis.PerformanceObserver;
  if (!Observer) return;
  const supported = Observer.supportedEntryTypes ?? [];
  const type = supported.includes('long-animation-frame')
    ? 'long-animation-frame'
    : supported.includes('longtask')
      ? 'longtask'
      : null;
  if (!type) return;
  try {
    new Observer((list) => {
      for (const entry of list.getEntries()) {
        onLongFrame(
          entry.duration,
          type === 'long-animation-frame' ? frameSource(entry) : undefined,
        );
      }
    }).observe({ type, buffered: false });
  } catch {
    /* an embedder without the entry type — timing still works without it */
  }
}

function pathOf(input: RequestInfo | URL): string {
  const raw =
    typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
  try {
    return new URL(raw, globalThis.location?.origin ?? 'http://localhost').pathname;
  } catch {
    return raw;
  }
}
