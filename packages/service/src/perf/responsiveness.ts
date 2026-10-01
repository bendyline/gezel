import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { Session } from 'node:inspector/promises';
import { join } from 'node:path';
import { type IntervalHistogram, monitorEventLoopDelay } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import {
  type ClientPerfReport,
  type PerfSlowRequest,
  type PerfSnapshot,
  type PerfStall,
  type PerfWork,
  createLogger,
} from '@bendyline/gezel';

/**
 * Main-thread responsiveness monitor.
 *
 * The daemon runs on one event loop. In embedded mode (`pnpm app`, and the
 * packaged fallback) that loop is Electron's main thread, so a synchronous
 * block here freezes the window itself, and Windows labels it "Not Responding"
 * after 5 s. Before this existed a block under the suspend monitor's 10 s floor
 * left no trace, and a longer one was logged as "host resumed after Ns
 * suspended": sleep that never happened (two of them during one catalog
 * update, 2026-09-30).
 *
 * Detection is a watchdog worker, not the loop's own timing: the main thread
 * bumps a shared counter and a worker with its own event loop notices when it
 * stops moving. If the worker's timer stayed on schedule, the main thread was
 * blocked; if the worker was late too, the whole process or host was paused,
 * which is the suspend clock's business. `eventLoopUtilization()` cannot make
 * that call: Electron's main process reports it as all zeros.
 */

const log = createLogger('perf');

const BEAT_MS = 100;
/** Shorter blocks are ordinary GC and JSON work; not worth a record. */
export const STALL_RECORD_MS = 500;
const STALL_LOG_MS = 1_000;
/** Windows marks an unresponsive window "Not Responding" after 5 s. */
const STALL_WARN_MS = 5_000;
const SLOW_REQUEST_RECORD_MS = 250;
const SLOW_REQUEST_LOG_MS = 1_000;
const RING_SIZE = 50;
/** Finished work is kept this long so a stall can name what ran through it. */
const FINISHED_WORK_KEEP_MS = 120_000;
const FINISHED_WORK_MIN_MS = 50;
const FINISHED_WORK_CAP = 500;
const DELAY_WINDOW_MS = 5 * 60_000;
const PROFILE_WINDOW_MS = 60_000;
const PROFILE_SAMPLING_US = 5_000;
const PROFILE_KEEP = 20;
const LABEL_MAX = 200;

const WATCHDOG_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const beat = new Int32Array(workerData.buffer);
const tickMs = workerData.tickMs;
const thresholdMs = workerData.thresholdMs;
let lastValue = Atomics.load(beat, 0);
let lastChange = Date.now();
let lastTick = Date.now();
let maxLate = 0;
setInterval(() => {
  const now = Date.now();
  const late = now - lastTick - tickMs;
  lastTick = now;
  const value = Atomics.load(beat, 0);
  if (value === lastValue) {
    if (late > maxLate) maxLate = late;
    return;
  }
  const stale = now - lastChange;
  if (stale >= thresholdMs) {
    parentPort.postMessage({ startedAt: lastChange, durationMs: stale, watchdogLateMs: maxLate });
  }
  lastValue = value;
  lastChange = now;
  maxLate = 0;
}, tickMs);
`;

interface WatchdogReport {
  startedAt: number;
  durationMs: number;
  watchdogLateMs: number;
}

/**
 * A stale heartbeat is a main-thread block only when the watchdog itself kept
 * time. When the watchdog was late by a comparable amount, the process or the
 * host was paused, and blaming whatever was in flight would be a false lead.
 */
export function isMainThreadBlock(report: WatchdogReport): boolean {
  return report.watchdogLateMs < report.durationMs / 2;
}

interface ActiveWork {
  label: string;
  startedAt: number;
}

interface FinishedWork extends ActiveWork {
  endedAt: number;
}

/**
 * Work that overlapped `[start, end]`, most suspicious first. Running work
 * counts to `now`; a request that blocked the thread finishes the instant the
 * block ends, so finished work has to be searched too. Ranking is by overlap
 * with the block, then by the tightest fit: a 10 s request inside a 10 s block
 * outranks a 90 s long-poll that merely spanned it.
 */
export function workDuring(
  start: number,
  end: number,
  active: Iterable<ActiveWork>,
  finished: readonly FinishedWork[],
  now: number,
  limit = 6,
): PerfWork[] {
  const hits: Array<PerfWork & { overlap: number }> = [];
  const consider = (w: ActiveWork, until: number) => {
    const overlap = Math.min(until, end) - Math.max(w.startedAt, start);
    if (overlap > 0) hits.push({ label: w.label, durationMs: until - w.startedAt, overlap });
  };
  for (const w of active) consider(w, now);
  for (const w of finished) consider(w, w.endedAt);
  hits.sort((a, b) => b.overlap - a.overlap || a.durationMs - b.durationMs);
  return hits.slice(0, limit).map(({ label, durationMs }) => ({ label, durationMs }));
}

export function formatPerfMs(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m${Math.round((ms % 60_000) / 1_000)}s`;
}

function pushRing<T>(ring: T[], item: T): void {
  ring.push(item);
  if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE);
}

function clip(label: string): string {
  return label.length > LABEL_MAX ? `${label.slice(0, LABEL_MAX - 1)}…` : label;
}

/**
 * Rolling CPU profile of the main thread, kept only when a window contains a
 * stall. The V8 sampler runs on its own thread, so samples land inside a
 * synchronous block, native calls included — which is what makes the saved
 * profile a verdict rather than a suspect list.
 */
class StallProfiler {
  private session: Session | null = null;
  private running = false;
  private disabled = false;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly dir: string,
    private readonly wanted: () => boolean,
  ) {}

  get active(): boolean {
    return this.running;
  }

  /** Called every window: start, stop, or roll the profile per `wanted()`. */
  roll(): void {
    this.enqueue(async () => {
      const want = this.wantNow();
      if (want && !this.running) await this.begin();
      else if (!want && this.running) await this.end();
      else if (this.running) {
        await this.end();
        await this.begin();
      }
    });
  }

  /** Save the current window's profile. Resolves to the file name, or null. */
  capture(at: number, durationMs: number): Promise<string | null> {
    return this.enqueue(async () => {
      if (!this.running || !this.session) return null;
      const { profile } = await this.session.post('Profiler.stop');
      this.running = false;
      const stamp = new Date(at).toISOString().replace(/[:.]/g, '-');
      const name = `stall-${stamp}-${Math.round(durationMs)}ms.cpuprofile`;
      await mkdir(this.dir, { recursive: true });
      await writeFile(join(this.dir, name), JSON.stringify(profile));
      await this.prune();
      if (this.wantNow()) await this.begin();
      return name;
    });
  }

  dispose(): Promise<void> {
    return this.enqueue(async () => {
      await this.end();
      this.session?.disconnect();
      this.session = null;
    }).then(() => undefined);
  }

  private wantNow(): boolean {
    if (this.disabled) return false;
    try {
      return this.wanted();
    } catch {
      return false;
    }
  }

  private async begin(): Promise<void> {
    if (!this.session) {
      const session = new Session();
      session.connect();
      this.session = session;
    }
    await this.session.post('Profiler.enable');
    await this.session.post('Profiler.setSamplingInterval', { interval: PROFILE_SAMPLING_US });
    await this.session.post('Profiler.start');
    this.running = true;
  }

  private async end(): Promise<void> {
    if (!this.running || !this.session) return;
    this.running = false;
    await this.session.post('Profiler.stop');
  }

  private async prune(): Promise<void> {
    const names = (await readdir(this.dir))
      .filter((n) => n.startsWith('stall-') && n.endsWith('.cpuprofile'))
      .sort();
    for (const old of names.slice(0, Math.max(0, names.length - PROFILE_KEEP))) {
      await rm(join(this.dir, old), { force: true });
    }
  }

  private enqueue<T>(op: () => Promise<T>): Promise<T | null> {
    const next = this.chain.then(op).catch((err: unknown) => {
      // Another inspector client (a debugger attached with --inspect) can own
      // the profiler. Losing profiles must never cost the daemon anything else.
      this.disabled = true;
      this.running = false;
      log.warn(
        `CPU profiling for stalls is off for this run: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    });
    this.chain = next;
    return next;
  }
}

export interface ResponsivenessMonitorOptions {
  /** `logs/` under the gezel home; profiles land in `logs/perf/`. */
  logsDir: string;
  /** Record a rolling CPU profile so the next stall can be explained. Read every minute. */
  profileWhen?: () => boolean;
}

class ResponsivenessMonitor {
  readonly startedAt = Date.now();
  private readonly active = new Map<number, ActiveWork>();
  private finished: FinishedWork[] = [];
  private readonly stalls: PerfStall[] = [];
  private readonly slowRequests: PerfSlowRequest[] = [];
  private readonly clientReports: PerfSnapshot['clientReports'] = [];
  private nextId = 1;
  private readonly beat = new Int32Array(new SharedArrayBuffer(4));
  private readonly beatTimer: ReturnType<typeof setInterval>;
  private readonly windowTimer: ReturnType<typeof setInterval>;
  private readonly delay: IntervalHistogram;
  private delayWindowStartedAt = Date.now();
  private watchdog: Worker | null = null;
  private readonly profiler: StallProfiler;

  constructor(opts: ResponsivenessMonitorOptions) {
    this.beatTimer = setInterval(() => Atomics.add(this.beat, 0, 1), BEAT_MS);
    this.beatTimer.unref?.();
    this.delay = monitorEventLoopDelay({ resolution: 20 });
    this.delay.enable();
    this.profiler = new StallProfiler(
      join(opts.logsDir, 'perf'),
      opts.profileWhen ?? (() => false),
    );
    this.windowTimer = setInterval(() => {
      this.profiler.roll();
      if (Date.now() - this.delayWindowStartedAt >= DELAY_WINDOW_MS) {
        this.delay.reset();
        this.delayWindowStartedAt = Date.now();
      }
    }, PROFILE_WINDOW_MS);
    this.windowTimer.unref?.();
    this.profiler.roll();
    this.startWatchdog();
  }

  begin(label: string): (outcome?: { status?: number; method?: string; path?: string }) => void {
    const id = this.nextId++;
    const work: ActiveWork = { label: clip(label), startedAt: Date.now() };
    this.active.set(id, work);
    return (outcome) => {
      if (!this.active.delete(id)) return;
      const endedAt = Date.now();
      const durationMs = endedAt - work.startedAt;
      if (durationMs >= FINISHED_WORK_MIN_MS) this.remember({ ...work, endedAt });
      if (outcome?.method && outcome.path && durationMs >= SLOW_REQUEST_RECORD_MS) {
        const status = outcome.status ?? 0;
        pushRing(this.slowRequests, {
          at: new Date(work.startedAt).toISOString(),
          method: outcome.method,
          path: clip(outcome.path),
          status,
          durationMs,
        });
        if (durationMs >= SLOW_REQUEST_LOG_MS) {
          log.info(`slow request ${work.label} ${formatPerfMs(durationMs)} (${status})`);
        }
      }
    };
  }

  recordClient(report: ClientPerfReport): void {
    pushRing(this.clientReports, { receivedAt: new Date().toISOString(), report });
    log.info(`ui: ${describeClientReport(report)}`);
  }

  snapshot(): PerfSnapshot {
    const now = Date.now();
    const count = this.delay.count;
    return {
      running: true,
      startedAt: new Date(this.startedAt).toISOString(),
      profiling: this.profiler.active,
      eventLoopDelay:
        count > 0
          ? {
              windowStartedAt: new Date(this.delayWindowStartedAt).toISOString(),
              p50Ms: this.delay.percentile(50) / 1e6,
              p99Ms: this.delay.percentile(99) / 1e6,
              maxMs: this.delay.max / 1e6,
            }
          : null,
      stalls: [...this.stalls],
      slowRequests: [...this.slowRequests],
      inflight: [...this.active.values()]
        .map((w) => ({ label: w.label, durationMs: now - w.startedAt }))
        .sort((a, b) => b.durationMs - a.durationMs),
      clientReports: [...this.clientReports],
    };
  }

  async dispose(): Promise<void> {
    clearInterval(this.beatTimer);
    clearInterval(this.windowTimer);
    this.delay.disable();
    const watchdog = this.watchdog;
    this.watchdog = null;
    await Promise.all([watchdog?.terminate(), this.profiler.dispose()]);
  }

  private remember(work: FinishedWork): void {
    const cutoff = work.endedAt - FINISHED_WORK_KEEP_MS;
    const oldest = this.finished[0];
    if (this.finished.length >= FINISHED_WORK_CAP || (oldest && oldest.endedAt < cutoff)) {
      this.finished = this.finished
        .filter((w) => w.endedAt >= cutoff)
        .slice(-(FINISHED_WORK_CAP - 1));
    }
    this.finished.push(work);
  }

  private startWatchdog(): void {
    try {
      const worker = new Worker(WATCHDOG_SOURCE, {
        eval: true,
        workerData: { buffer: this.beat.buffer, tickMs: BEAT_MS, thresholdMs: STALL_RECORD_MS },
      });
      worker.on('message', (report: WatchdogReport) => this.onWatchdogReport(report));
      worker.on('error', (err) => {
        log.warn(`stall watchdog stopped: ${err instanceof Error ? err.message : String(err)}`);
      });
      worker.unref();
      this.watchdog = worker;
    } catch (err) {
      log.warn(`stall watchdog unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private onWatchdogReport(report: WatchdogReport): void {
    if (!isMainThreadBlock(report)) return;
    const now = Date.now();
    const stall: PerfStall = {
      at: new Date(report.startedAt).toISOString(),
      durationMs: report.durationMs,
      during: workDuring(
        report.startedAt,
        report.startedAt + report.durationMs,
        this.active.values(),
        this.finished,
        now,
      ),
    };
    pushRing(this.stalls, stall);
    if (report.durationMs < STALL_LOG_MS) return;
    const running =
      stall.during.length > 0
        ? stall.during.map((w) => `${w.label} (${formatPerfMs(w.durationMs)})`).join(', ')
        : 'nothing tracked';
    const line = `main thread blocked for ${formatPerfMs(report.durationMs)} — running: ${running}`;
    if (report.durationMs >= STALL_WARN_MS) log.warn(line);
    else log.info(line);
    void this.profiler.capture(report.startedAt, report.durationMs).then((name) => {
      if (!name) return;
      stall.profile = name;
      log.info(`CPU profile of the ${formatPerfMs(report.durationMs)} block: logs/perf/${name}`);
    });
  }
}

export function describeClientReport(report: ClientPerfReport): string {
  if (report.kind === 'long-task') {
    return `renderer blocked for ${formatPerfMs(report.durationMs)} on ${report.view}${
      report.source ? ` in ${report.source}` : ''
    }`;
  }
  const slowest = report.slowest[0];
  const parts = [
    `opened ${report.view} in ${formatPerfMs(report.settledMs)}${report.unsettled ? ' (still loading)' : ''}`,
    `first frame ${formatPerfMs(report.firstFrameMs)}`,
    `${report.requests} request${report.requests === 1 ? '' : 's'}`,
  ];
  if (slowest) {
    parts.push(
      `slowest ${slowest.method} ${slowest.path} ${formatPerfMs(slowest.ms)}${
        slowest.serverMs !== undefined ? ` (daemon ${formatPerfMs(slowest.serverMs)})` : ''
      }`,
    );
  }
  if (report.longTasks.count > 0) {
    parts.push(
      `renderer busy ${report.longTasks.count}× (max ${formatPerfMs(report.longTasks.maxMs)})`,
    );
  }
  return parts.join(', ');
}

let monitor: ResponsivenessMonitor | null = null;
const noop = (): void => {};

/**
 * Start watching the main thread. A second start replaces the first; the
 * returned stopper only ever stops the monitor it started.
 */
export function startResponsivenessMonitor(
  opts: ResponsivenessMonitorOptions,
): () => Promise<void> {
  if (monitor) void monitor.dispose();
  const mine = new ResponsivenessMonitor(opts);
  monitor = mine;
  return async () => {
    if (monitor === mine) monitor = null;
    await mine.dispose();
  };
}

/**
 * Mark a stretch of background work so a stall that happens during it can
 * name it. Returns the function that ends the stretch; free when no monitor runs.
 */
export function beginPerfWork(label: string): () => void {
  if (!monitor) return noop;
  const end = monitor.begin(label);
  return () => end();
}

/** Time one HTTP request. The returned function takes the response status. */
export function beginPerfRequest(method: string, path: string): (status: number) => void {
  if (!monitor) return noop;
  const end = monitor.begin(`${method} ${path}`);
  return (status) => end({ status, method, path });
}

export function recordClientPerfReport(report: ClientPerfReport): void {
  monitor?.recordClient(report);
}

export function perfSnapshot(): PerfSnapshot {
  return (
    monitor?.snapshot() ?? {
      running: false,
      startedAt: null,
      profiling: false,
      eventLoopDelay: null,
      stalls: [],
      slowRequests: [],
      inflight: [],
      clientReports: [],
    }
  );
}
