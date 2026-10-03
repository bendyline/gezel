import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { Session } from 'node:inspector/promises';
import { join } from 'node:path';
import { type RecordableHistogram, createHistogram } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import {
  type ClientPerfReport,
  type PerfSlowRequest,
  type PerfSnapshot,
  type PerfStall,
  type PerfWork,
  createLogger,
} from '@bendyline/gezel';
import { redactPathSecrets } from './redact-path.js';

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
 * Detection is a heartbeat on the main thread that notices its own gaps, with
 * a watchdog worker as the witness: if the worker's timer stayed on schedule
 * through the gap, the main thread was blocked; if the worker was late too, the
 * whole process or host was paused, which is the suspend clock's business.
 * `eventLoopUtilization()` cannot make that call: Electron's main process
 * reports it as all zeros.
 *
 * Every tick here wakes an otherwise idle process, and the machine service is
 * idle almost all of the time. A 20 ms event-loop-delay histogram plus 100 ms
 * ticks on both threads took an idle daemon from 13 to 59 context switches a
 * second (v1.26275.85), so the beat doubles as the delay sampler and both
 * threads tick at the coarsest period that still measures a recordable stall.
 */

const log = createLogger('perf');

/**
 * A gap is measured to within one beat, so this has to stay well inside
 * `STALL_RECORD_MS`. At the same period, a pause long enough to log leaves the
 * watchdog late by more than half the gap, which is what `isMainThreadBlock`
 * needs to rule the main thread out.
 */
export const BEAT_MS = 250;
export const WATCHDOG_TICK_MS = 250;
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

/**
 * The witness. It keeps its own late ticks and, asked about a gap, answers
 * with the worst one since the gap began. A tick late by less than a period is
 * not kept: it cannot reach half of a recordable gap.
 *
 * It sleeps on a futex instead of running an event loop: a worker woken by its
 * own timer cost about 1.6 context switches per tick on Windows, against 1.0
 * for this. The main thread posts the question and then flips `asked` to wake
 * it early. Ticks are settled before questions, so a late tick at a resume is
 * always on record by the time the question about that gap is answered.
 */
const WATCHDOG_SOURCE = `
const { parentPort, receiveMessageOnPort, workerData } = require('node:worker_threads');
const tickMs = workerData.tickMs;
const asked = new Int32Array(workerData.asked);
const lateTicks = [];
let lastTick = Date.now();
for (;;) {
  Atomics.wait(asked, 0, 0, Math.max(0, lastTick + tickMs - Date.now()));
  const now = Date.now();
  if (now - lastTick >= tickMs) {
    const lateMs = now - lastTick - tickMs;
    lastTick = now;
    if (lateMs >= tickMs) {
      lateTicks.push({ at: now, lateMs });
      if (lateTicks.length > 32) lateTicks.shift();
    }
  }
  Atomics.store(asked, 0, 0);
  for (let m = receiveMessageOnPort(parentPort); m; m = receiveMessageOnPort(parentPort)) {
    const gap = m.message;
    let lateMs = 0;
    for (const tick of lateTicks) {
      if (tick.at > gap.startedAt && tick.lateMs > lateMs) lateMs = tick.lateMs;
    }
    parentPort.postMessage({ startedAt: gap.startedAt, durationMs: gap.durationMs, watchdogLateMs: lateMs });
  }
}
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
  private lastBeatAt = Date.now();
  private readonly beatTimer: ReturnType<typeof setInterval>;
  private readonly windowTimer: ReturnType<typeof setInterval>;
  /** Beat lateness in nanoseconds, the unit `monitorEventLoopDelay` used. */
  private readonly delay: RecordableHistogram = createHistogram();
  private delayWindowStartedAt = Date.now();
  private readonly watchdogAsked = new Int32Array(new SharedArrayBuffer(4));
  private watchdog: Worker | null = null;
  private readonly profiler: StallProfiler;

  constructor(opts: ResponsivenessMonitorOptions) {
    this.beatTimer = setInterval(() => this.beat(), BEAT_MS);
    this.beatTimer.unref?.();
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
    const work: ActiveWork = { label: clip(redactPathSecrets(label)), startedAt: Date.now() };
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
          path: clip(redactPathSecrets(outcome.path)),
          status,
          durationMs,
        });
        if (durationMs >= SLOW_REQUEST_LOG_MS) {
          log.info(`slow request ${work.label} ${formatPerfMs(durationMs)} (${status})`);
        }
      }
    };
  }

  recordClient(received: ClientPerfReport): void {
    const report = redactClientReport(received);
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
    const watchdog = this.watchdog;
    this.watchdog = null;
    await Promise.all([watchdog?.terminate(), this.profiler.dispose()]);
  }

  /**
   * A gap is reported from the last beat, the last moment the thread was seen
   * alive, so it overstates the block by less than one beat rather than
   * missing one of a recordable size.
   */
  private beat(): void {
    const now = Date.now();
    const startedAt = this.lastBeatAt;
    this.lastBeatAt = now;
    const gapMs = now - startedAt;
    this.delay.record(Math.max(1, Math.round((gapMs - BEAT_MS) * 1e6)));
    if (gapMs < STALL_RECORD_MS || !this.watchdog) return;
    this.watchdog.postMessage({ startedAt, durationMs: gapMs });
    Atomics.store(this.watchdogAsked, 0, 1);
    Atomics.notify(this.watchdogAsked, 0);
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
        workerData: { tickMs: WATCHDOG_TICK_MS, asked: this.watchdogAsked.buffer },
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

/**
 * The renderer reports the paths it timed, so they are scrubbed like the
 * daemon's own. Never longer than what arrived: `GET /perf` validates the
 * stored report again against the same length caps.
 */
export function redactClientReport(report: ClientPerfReport): ClientPerfReport {
  const scrub = (text: string): string => redactPathSecrets(text).slice(0, text.length);
  if (report.kind === 'long-task') {
    return {
      ...report,
      view: scrub(report.view),
      ...(report.source !== undefined ? { source: scrub(report.source) } : {}),
    };
  }
  return {
    ...report,
    view: scrub(report.view),
    slowest: report.slowest.map((request) => ({ ...request, path: scrub(request.path) })),
  };
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
