import {
  type ClientLongTasks,
  type ClientPerfReport,
  type ClientPerfRequest,
  createLogger,
} from '@bendyline/gezel';

/**
 * Renderer-side responsiveness timing: how long a move between views (or
 * between a view's own tabs) took, from the person's click to the frame that
 * drew the last response the new view waited on, how far its content moved
 * while it filled in, and when the renderer's own main thread was too busy to
 * paint. The daemon logs what it is handed beside its own stall and
 * slow-request lines, so one log explains a sluggish moment from both ends.
 *
 * Views are not kept alive — every switch remounts and refetches — so the
 * finish line is "settled": the first frame usually shows a placeholder, the
 * last response shows the view.
 *
 * The clock starts at the click or key press that caused the move, not when
 * the view code heard of it: a tab's own effects can start fetching before
 * its parent reports the move, so requests begun since that input are charged
 * to the move. Polling (`asBackground`) is counted apart and never holds a
 * navigation open.
 */

const log = createLogger('perf');

/** The view has settled once none of its own requests ran for this long. */
const QUIET_MS = 400;
const GIVE_UP_MS = 20_000;
/** Navigations slower than this are handed to the daemon. */
export const REPORT_NAVIGATION_MS = 1_000;
/** ...as are navigations during which the renderer froze for this long. */
const REPORT_NAVIGATION_FRAME_MS = 200;
/** ...and those whose content moved this much while it filled in ("poor" in Chromium's scale). */
const REPORT_LAYOUT_SHIFT = 0.25;
/** A frozen frame outside any navigation is reported past this. */
const REPORT_LONG_FRAME_MS = 500;
const LONG_FRAME_REPORT_GAP_MS = 5_000;
/** A navigation starts at the input that caused it when that input is this recent. */
const INPUT_WINDOW_MS = 1_000;
const RECENT_LIMIT = 30;
const FINISHED_REQUEST_LIMIT = 64;
const VIEW_MAX = 200;
const PERF_ENDPOINT_PREFIX = '/api/system/perf';
/** Set to "1" (the perf harness does) to hand every navigation to the daemon. */
export const REPORT_ALL_STORAGE_KEY = 'gezel:perf:report-all';

export type NavigationScope = 'view' | 'part';

/** After the next frame has painted: a frame callback runs before paint, the timeout after it. */
function afterNextPaint(fn: () => void): void {
  if (typeof requestAnimationFrame !== 'function') {
    setTimeout(fn, 0);
    return;
  }
  requestAnimationFrame(() => setTimeout(fn, 0));
}

class Navigation {
  firstFrameMs: number | null = null;
  lastResponseMs = 0;
  paintedMs = 0;
  contentMs: number | null = null;
  layoutShift = 0;
  backgroundRequests = 0;
  pending = 0;
  done = false;
  readonly requests: ClientPerfRequest[] = [];
  readonly longTasks: ClientLongTasks = { count: 0, totalMs: 0, maxMs: 0 };
  private paintsPending = 0;
  private quietTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly giveUpTimer: ReturnType<typeof setTimeout>;

  constructor(
    readonly view: string,
    readonly scope: NavigationScope,
    readonly startedAt: number,
    private readonly finish: (nav: Navigation, unsettled: boolean) => void,
  ) {
    afterNextPaint(() => {
      if (this.done) return;
      this.firstFrameMs = performance.now() - this.startedAt;
      this.paintedMs = Math.max(this.paintedMs, this.firstFrameMs);
      this.checkQuiet();
    });
    this.giveUpTimer = setTimeout(() => this.finish(this, true), GIVE_UP_MS);
  }

  requestStarted(): void {
    this.pending++;
    this.clearQuiet();
  }

  /** Headers arrived. The caller usually reads the body next (`bodyStarted`). */
  requestEnded(request: ClientPerfRequest, endedAt: number): void {
    if (this.done) return;
    this.pending = Math.max(0, this.pending - 1);
    this.adoptFinished(request, endedAt);
    this.paintAfter();
  }

  bodyStarted(): void {
    if (this.done) return;
    this.pending++;
    this.clearQuiet();
  }

  bodyEnded(): void {
    if (this.done) return;
    this.pending = Math.max(0, this.pending - 1);
    this.paintAfter();
  }

  /** A request that began after the input but finished before this navigation started. */
  adoptFinished(request: ClientPerfRequest, endedAt: number): void {
    this.requests.push(request);
    this.lastResponseMs = Math.max(this.lastResponseMs, endedAt - this.startedAt);
  }

  contentPainted(): void {
    if (this.done || this.contentMs !== null) return;
    this.contentMs = Number.NaN;
    afterNextPaint(() => {
      if (!this.done) this.contentMs = performance.now() - this.startedAt;
    });
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

  /** The view draws what a response carried on the frame after it lands. */
  private paintAfter(): void {
    this.paintsPending++;
    afterNextPaint(() => {
      this.paintsPending--;
      if (this.done) return;
      this.paintedMs = Math.max(this.paintedMs, performance.now() - this.startedAt);
      this.checkQuiet();
    });
  }

  private checkQuiet(): void {
    if (this.done || this.firstFrameMs === null || this.pending > 0 || this.paintsPending > 0) {
      return;
    }
    this.clearQuiet();
    this.quietTimer = setTimeout(() => this.finish(this, false), QUIET_MS);
  }

  private clearQuiet(): void {
    if (this.quietTimer !== null) clearTimeout(this.quietTimer);
    this.quietTimer = null;
  }
}

interface RequestRecord {
  method: string;
  path: string;
  startedAt: number;
  background: boolean;
  nav: Navigation | null;
}

interface FinishedRequest {
  record: RequestRecord;
  request: ClientPerfRequest;
  endedAt: number;
}

let current: Navigation | null = null;
let currentView = 'home';
let sink: ((report: ClientPerfReport) => void) | null = null;
let lastLongFrameReportAt = 0;
let observing = false;
let lastInputAt = Number.NEGATIVE_INFINITY;
let backgroundDepth = 0;
let reportAll: boolean | null = null;
const inflight = new Set<RequestRecord>();
const finished: FinishedRequest[] = [];
const recent: ClientPerfReport[] = [];

/** Where reports worth the daemon's attention go. */
export function setPerfReportSink(fn: ((report: ClientPerfReport) => void) | null): void {
  sink = fn;
}

/**
 * Start timing a move to `view`. A navigation still loading is abandoned,
 * except that a move inside a view caused by the same input as the move to
 * that view folds into it (one click, one navigation).
 */
export function beginNavigation(view: string, options: { scope?: NavigationScope } = {}): void {
  ensureObservers();
  const scope = options.scope ?? 'view';
  const sinceInput = performance.now() - lastInputAt;
  const startedAt =
    sinceInput >= 0 && sinceInput < INPUT_WINDOW_MS ? lastInputAt : performance.now();
  if (scope === 'part' && current && current.startedAt === startedAt) return;
  if (current) {
    const elapsed = performance.now() - current.startedAt;
    const previous = current;
    current = null;
    if (elapsed >= REPORT_NAVIGATION_MS) publish(toReport(previous, true, elapsed));
    previous.close();
  }
  currentView = view;
  const nav = new Navigation(view.slice(0, VIEW_MAX), scope, startedAt, (done, unsettled) => {
    if (current === done) current = null;
    // The input has been answered; a later move starts its own clock.
    if (lastInputAt === done.startedAt) lastInputAt = Number.NEGATIVE_INFINITY;
    done.close();
    publish(toReport(done, unsettled, performance.now() - done.startedAt));
  });
  current = nav;
  for (const record of inflight) {
    if (record.background || record.startedAt < startedAt) continue;
    record.nav = nav;
    nav.requestStarted();
  }
  for (const done of finished) {
    if (done.record.background || done.record.startedAt < startedAt) continue;
    nav.adoptFinished(done.request, done.endedAt);
  }
}

/**
 * The view's main content (a chat's messages, not its placeholder) is on
 * screen. The first call during a navigation wins.
 */
export function markContentPainted(): void {
  current?.contentPainted();
}

/**
 * Run `fn` with the requests it starts counted as background polling: they
 * belong to no view and never hold a navigation open. Requests are charged
 * synchronously, when the client method is called.
 */
export function asBackground<T>(fn: () => T): T {
  backgroundDepth++;
  try {
    return fn();
  } finally {
    backgroundDepth--;
  }
}

/**
 * Open a background span that cannot be expressed as one call: requests
 * started until the returned release runs are background work. For work
 * React starts across several components in one synchronous flush (a kept
 * view's effects running again as it is shown). Released at the latest in a
 * microtask, so a span never outlives the flush that opened it.
 */
export function openBackgroundSpan(): () => void {
  backgroundDepth++;
  let open = true;
  const release = () => {
    if (!open) return;
    open = false;
    backgroundDepth--;
  };
  queueMicrotask(release);
  return release;
}

/** Wrap the API client's fetch so each request is charged to the navigation that issued it. */
export function instrumentFetch(base: typeof fetch): typeof fetch {
  ensureObservers();
  return async (input, init) => {
    const path = pathOf(input);
    if (path.startsWith(PERF_ENDPOINT_PREFIX)) return base(input, init);
    const method = (
      init?.method ??
      (typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET')
    ).toUpperCase();
    const record: RequestRecord = {
      method,
      path,
      startedAt: performance.now(),
      background: backgroundDepth > 0,
      nav: null,
    };
    if (record.background) {
      if (current) current.backgroundRequests++;
    } else if (current) {
      record.nav = current;
      current.requestStarted();
    }
    inflight.add(record);
    const settle = (request: ClientPerfRequest) => {
      const endedAt = performance.now();
      inflight.delete(record);
      finished.push({ record, request, endedAt });
      if (finished.length > FINISHED_REQUEST_LIMIT) finished.shift();
      record.nav?.requestEnded(request, endedAt);
    };
    let res: Response;
    try {
      res = await base(input, init);
    } catch (error) {
      settle({ method, path, ms: Math.round(performance.now() - record.startedAt) });
      throw error;
    }
    const serverMs = parseServerTiming(res.headers?.get?.('server-timing') ?? null);
    settle({
      method,
      path,
      ms: Math.round(performance.now() - record.startedAt),
      ...(serverMs !== undefined ? { serverMs } : {}),
    });
    if (!record.background) watchBody(res, record);
    return res;
  };
}

/**
 * A view draws a response only after its body is read and parsed. Count a
 * body read the caller starts (`json()`, `text()`…) toward the navigation, so
 * "drawn" means the data reached the screen, not that headers arrived.
 */
function watchBody(res: Response, record: RequestRecord): void {
  for (const name of ['json', 'text', 'blob', 'arrayBuffer'] as const) {
    const read = (res as Partial<Response>)[name];
    if (typeof read !== 'function') continue;
    try {
      Object.defineProperty(res, name, {
        configurable: true,
        writable: true,
        value: (...args: unknown[]) => {
          const nav = record.nav;
          nav?.bodyStarted();
          return (read as (...a: unknown[]) => Promise<unknown>)
            .apply(res, args)
            .finally(() => nav?.bodyEnded());
        },
      });
    } catch {
      return;
    }
  }
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
  if (reportsEverything()) return true;
  return (
    Math.max(report.settledMs, report.paintedMs ?? 0) >= REPORT_NAVIGATION_MS ||
    report.longTasks.maxMs >= REPORT_NAVIGATION_FRAME_MS ||
    (report.layoutShift ?? 0) >= REPORT_LAYOUT_SHIFT
  );
}

function reportsEverything(): boolean {
  if (reportAll === null) {
    try {
      reportAll = globalThis.localStorage?.getItem(REPORT_ALL_STORAGE_KEY) === '1';
    } catch {
      reportAll = false;
    }
  }
  return reportAll;
}

function toReport(nav: Navigation, unsettled: boolean, elapsedMs: number): ClientPerfReport {
  const firstFrameMs = nav.firstFrameMs ?? elapsedMs;
  const settledMs = unsettled ? elapsedMs : Math.max(firstFrameMs, nav.lastResponseMs);
  const paintedMs = unsettled ? elapsedMs : Math.max(settledMs, nav.paintedMs);
  const contentMs = nav.contentMs;
  return {
    kind: 'navigation',
    view: nav.view,
    ...(nav.scope === 'part' ? { scope: 'part' as const } : {}),
    firstFrameMs: Math.round(firstFrameMs),
    settledMs: Math.round(settledMs),
    paintedMs: Math.round(paintedMs),
    ...(contentMs !== null && Number.isFinite(contentMs)
      ? { contentMs: Math.round(contentMs) }
      : {}),
    ...(nav.layoutShift > 0 ? { layoutShift: Math.round(nav.layoutShift * 1000) / 1000 } : {}),
    ...(unsettled ? { unsettled: true } : {}),
    requests: nav.requests.length,
    ...(nav.backgroundRequests > 0 ? { backgroundRequests: nav.backgroundRequests } : {}),
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
    view: currentView.slice(0, VIEW_MAX),
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

export interface LayoutShiftLike {
  value: number;
  sources?: readonly { node?: Node | null }[];
}

/**
 * The part of a layout shift that is content moving. A shift made only by
 * the shell's frame (`data-layout-frame`: the rail folding for a list area,
 * the pane box resizing with it) is a designed change of layout in the frame
 * of the swap, not a view popping in, and counts for nothing.
 */
export function contentShiftValue(entry: LayoutShiftLike): number {
  const elements = (entry.sources ?? [])
    .map((source) => source.node)
    .filter((node): node is Element => typeof Element !== 'undefined' && node instanceof Element);
  const frameOnly =
    elements.length > 0 &&
    elements.every(
      (element) =>
        element.hasAttribute('data-layout-frame') ||
        element.closest('[data-layout-frame="rail"]') !== null,
    );
  return frameOnly ? 0 : entry.value;
}

/**
 * The input that starts a navigation. `timeStamp` is when the browser
 * received it, so time the page spent too busy to dispatch it counts; a
 * timestamp on another clock (older engines, jsdom) falls back to now.
 */
function noteInput(event: Event): void {
  const now = performance.now();
  const at = event.timeStamp;
  lastInputAt = at > 0 && at <= now && now - at < INPUT_WINDOW_MS ? at : now;
}

function ensureObservers(): void {
  if (observing) return;
  observing = true;
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    const options = { capture: true, passive: true };
    window.addEventListener('click', noteInput, options);
    window.addEventListener('keydown', noteInput, options);
  }
  const Observer = globalThis.PerformanceObserver;
  if (!Observer) return;
  const supported = Observer.supportedEntryTypes ?? [];
  const type = supported.includes('long-animation-frame')
    ? 'long-animation-frame'
    : supported.includes('longtask')
      ? 'longtask'
      : null;
  if (type) {
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
  if (supported.includes('layout-shift')) {
    try {
      new Observer((list) => {
        if (!current) return;
        for (const entry of list.getEntries()) {
          // Shifts right after the click count too: a view filling in stages
          // is exactly what Chromium's own score forgives as input-driven.
          current.layoutShift += contentShiftValue(entry as unknown as LayoutShiftLike);
        }
      }).observe({ type: 'layout-shift', buffered: false });
    } catch {
      /* layout-shift is Chromium-only; WebKit phones go without */
    }
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
