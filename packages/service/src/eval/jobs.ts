/**
 * In-app eval jobs: queued, daemon-owned runs of the eval harness.
 *
 * A job is one selection (a suite, a subset, or hand-picked scenarios) ×
 * a trial count × one or more models. Each model runs as one `eval:all`
 * invocation, one after another, and the harness's `--events` channel
 * drives progress. The job outlives the request that created it: closing
 * Settings, reloading the window, or losing the SSE stream changes nothing,
 * which matters for runs measured in hours.
 *
 * Only one job runs at a time, on purpose. Evals measure a device; two at
 * once would measure contention. The harness's own device lock enforces the
 * same across processes, so a job waits (`waiting-for-device`) while a CLI
 * eval holds it rather than failing into it.
 *
 * State on disk, per job: `eval-runs/jobs/<id>/job.json` (the record) and
 * `harness.log` (everything the harness printed). A job that was running
 * when the daemon stopped is recorded as `interrupted` at the next boot.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { appendFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '@bendyline/gezel';
import {
  type EvalHarnessEvent,
  type EvalJob,
  EvalJobSchema,
  type EvalJobSpec,
  type EvalJobStreamEvent,
  type EvalJobTargetProgress,
  type EvalJobTargetSpec,
  parseEvalHarnessEventLine,
} from '@bendyline/gezel/eval';
import { killProcessTree } from '../utils/kill-process-tree.js';
import { type EvalHarness, type HarnessProcess, harnessBaseEnv, spawnHarness } from './harness.js';

const log = createLogger('eval-jobs');

/** Lines of harness output kept in memory per job for late subscribers. */
const LOG_RING_LINES = 500;
/** Grace between a polite stop and a forced one; trial teardown takes a while. */
const STOP_GRACE_MS = 90_000;
/** A quitting daemon can't wait for trial teardown the way a cancel can. */
const SHUTDOWN_GRACE_MS = 8_000;
const DEVICE_POLL_MS = 15_000;
/** Jobs listed by default; older records stay on disk. */
const LIST_LIMIT = 50;

/** What the service contributes to one target's launch (models, keys, browser). */
export interface PreparedEvalTarget {
  args: string[];
  env: NodeJS.ProcessEnv;
  /** Runs on this machine's accelerator, so it must hold the device lock. */
  needsDevice: boolean;
}

export interface EvalHistorySink {
  log(entry: {
    kind: string;
    summary: string;
    details?: Record<string, unknown>;
  }): Promise<unknown>;
}

export interface EvalJobManagerOptions {
  runsDir: string;
  harness: () => EvalHarness | null;
  /** Resolve one target's launch; throw a readable sentence to fail it. */
  prepareTarget: (target: EvalJobTargetSpec, spec: EvalJobSpec) => Promise<PreparedEvalTarget>;
  baseEnv?: () => NodeJS.ProcessEnv;
  history?: EvalHistorySink;
  /** Who else holds the eval device lock right now, or null. Test seam. */
  deviceLockHolder?: () => string | null;
  spawnImpl?: Parameters<typeof spawnHarness>[1]['spawnImpl'];
  stopGraceMs?: number;
  devicePollMs?: number;
}

interface JobState {
  job: EvalJob;
  log: string[];
  listeners: Set<(event: EvalJobStreamEvent) => void>;
  proc?: HarnessProcess;
  cancelRequested: boolean;
  wake?: () => void;
  /** Serializes job.json writes; trial events and status changes interleave. */
  persisting: Promise<void>;
}

/** Callers get a copy: the live record keeps changing under a running job. */
function snapshot(job: EvalJob): EvalJob {
  return structuredClone(job);
}

const TERMINAL: ReadonlySet<EvalJob['status']> = new Set([
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);

function slug(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60);
}

export class EvalJobManager {
  private readonly jobs = new Map<string, JobState>();
  private readonly order: string[] = [];
  private running: string | null = null;
  private loaded: Promise<void> | null = null;
  private stopping = false;

  constructor(private readonly opts: EvalJobManagerOptions) {}

  get jobsDir(): string {
    return join(this.opts.runsDir, 'jobs');
  }

  /** Load persisted jobs once; any that were live are now interrupted. */
  init(): Promise<void> {
    this.loaded ??= this.loadPersisted();
    return this.loaded;
  }

  async list(): Promise<EvalJob[]> {
    await this.init();
    return this.order
      .slice(-LIST_LIMIT)
      .reverse()
      .map((id) => this.jobs.get(id)?.job)
      .filter((job): job is EvalJob => job !== undefined)
      .map(snapshot);
  }

  async get(id: string): Promise<EvalJob | null> {
    await this.init();
    const job = this.jobs.get(id)?.job;
    return job ? snapshot(job) : null;
  }

  /** Trial ids a live job is running now — the results index's liveness source. */
  liveTrialIds(): Set<string> {
    const ids = new Set<string>();
    if (!this.running) return ids;
    for (const target of this.jobs.get(this.running)?.job.targets ?? []) {
      if (target.currentTrial) ids.add(target.currentTrial.trialId);
    }
    return ids;
  }

  async create(spec: EvalJobSpec): Promise<EvalJob> {
    await this.init();
    const harness = this.opts.harness();
    if (!harness) throw new Error('this install has no eval harness');
    const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 6)}`;
    const dir = join(this.jobsDir, id);
    const job: EvalJob = {
      id,
      spec,
      status: 'queued',
      createdAt: new Date().toISOString(),
      harness: harness.mode,
      dir,
      targets: spec.targets.map((target, index) => ({
        provider: target.provider,
        modelId: target.modelId,
        status: 'pending',
        runDir: join(
          dir,
          `${String(index + 1).padStart(2, '0')}-${target.provider}-${slug(target.modelId)}`,
        ),
        completedTrials: 0,
        passedTrials: 0,
      })),
    };
    await mkdir(dir, { recursive: true });
    const state: JobState = {
      job,
      log: [],
      listeners: new Set(),
      cancelRequested: false,
      persisting: Promise.resolve(),
    };
    this.jobs.set(id, state);
    this.order.push(id);
    await this.persist(state);
    const created = snapshot(job);
    void this.pump();
    return created;
  }

  async cancel(id: string): Promise<EvalJob | null> {
    await this.init();
    const state = this.jobs.get(id);
    if (!state) return null;
    if (TERMINAL.has(state.job.status)) return snapshot(state.job);
    state.cancelRequested = true;
    if (state.job.status === 'queued') {
      this.finishJob(state, 'cancelled');
      await this.persist(state);
      return snapshot(state.job);
    }
    state.wake?.();
    this.stopProcess(state);
    return snapshot(state.job);
  }

  subscribe(id: string, listener: (event: EvalJobStreamEvent) => void): (() => void) | null {
    const state = this.jobs.get(id);
    if (!state) return null;
    listener({ type: 'snapshot', job: snapshot(state.job), log: [...state.log] });
    state.listeners.add(listener);
    return () => state.listeners.delete(listener);
  }

  /**
   * Daemon shutdown: stop the running harness; the job reads `interrupted`.
   * Bounded well inside Electron's graceful-quit window — the harness gets a
   * short chance to finalize its trial, then its process tree is killed (the
   * trial daemon also exits on its own when the harness's pipe closes).
   */
  async shutdown(): Promise<void> {
    this.stopping = true;
    const id = this.running;
    if (!id) return;
    const state = this.jobs.get(id);
    if (!state) return;
    state.wake?.();
    const proc = state.proc;
    if (!proc) return;
    try {
      proc.child.kill('SIGTERM');
    } catch {
      // already gone
    }
    const settled = await Promise.race([
      proc.exited.then(() => true),
      new Promise<false>((resolveTimeout) =>
        setTimeout(() => resolveTimeout(false), SHUTDOWN_GRACE_MS).unref(),
      ),
    ]);
    if (!settled) {
      killProcessTree(proc.child);
      await proc.exited;
    }
  }

  // ── Execution ─────────────────────────────────────────────────────────

  private async pump(): Promise<void> {
    if (this.running || this.stopping) return;
    const next = this.order.find((id) => this.jobs.get(id)?.job.status === 'queued');
    if (!next) return;
    const state = this.jobs.get(next);
    if (!state) return;
    this.running = next;
    try {
      await this.runJob(state);
    } catch (err) {
      log.error(`[eval-jobs] job ${next} crashed:`, err);
      state.job.error = err instanceof Error ? err.message : String(err);
      this.finishJob(state, 'failed');
      await this.persist(state);
    } finally {
      this.running = null;
      void this.pump();
    }
  }

  private async runJob(state: JobState): Promise<void> {
    const job = state.job;
    job.startedAt = new Date().toISOString();
    this.update(state, 'running');
    for (const target of job.targets) {
      if (state.cancelRequested || this.stopping) break;
      await this.runTarget(state, target);
    }
    if (this.stopping && !state.cancelRequested) {
      this.finishJob(state, 'interrupted');
    } else if (state.cancelRequested) {
      for (const target of job.targets)
        if (target.status === 'pending') target.status = 'cancelled';
      this.finishJob(state, 'cancelled');
    } else {
      const ran = job.targets.some((t) => t.status === 'completed');
      this.finishJob(state, ran ? 'completed' : 'failed');
      if (!ran && !job.error) job.error = job.targets.find((t) => t.error)?.error;
    }
    await this.persist(state);
  }

  private async runTarget(state: JobState, target: EvalJobTargetProgress): Promise<void> {
    const job = state.job;
    // Preparing can mean a first-time engine download; show it as the active
    // target ("Preparing…") rather than one still waiting its turn.
    target.status = 'running';
    target.startedAt = new Date().toISOString();
    this.emitJob(state);
    let prepared: PreparedEvalTarget;
    try {
      prepared = await this.opts.prepareTarget(
        { provider: target.provider, modelId: target.modelId },
        job.spec,
      );
    } catch (err) {
      target.status = 'failed';
      target.error = err instanceof Error ? err.message : String(err);
      this.appendLog(state, `[eval] ${target.provider}/${target.modelId}: ${target.error}`);
      this.emitJob(state);
      await this.persist(state);
      return;
    }

    if (prepared.needsDevice && !(await this.waitForDevice(state))) {
      target.status = 'cancelled';
      return;
    }

    const harness = this.opts.harness();
    if (!harness) {
      target.status = 'failed';
      target.error = 'this install has no eval harness';
      return;
    }
    await mkdir(target.runDir, { recursive: true });
    this.update(state, 'running');

    const args = [...harnessArgs(job.spec, target), ...prepared.args];
    const launch = harness.launch('all', args);
    this.appendLog(
      state,
      `[eval] ${target.provider}/${target.modelId}: starting (${harness.mode} harness)`,
    );
    log.info(`[eval-jobs] ${job.id} ${launch.command} ${launch.args.join(' ')}`);

    let matrixEnded = false;
    let fatalLine: string | undefined;
    const errorTail: string[] = [];
    const harnessLog = join(job.dir, 'harness.log');
    let logWrites = Promise.resolve();
    const proc = spawnHarness(launch, {
      env: { ...(this.opts.baseEnv?.() ?? harnessBaseEnv()), ...prepared.env },
      ...(this.opts.spawnImpl ? { spawnImpl: this.opts.spawnImpl } : {}),
      onLine: (line, stream) => {
        logWrites = logWrites.then(() => appendFile(harnessLog, `${line}\n`).catch(() => {}));
        const event = stream === 'stdout' ? parseEvalHarnessEventLine(line) : null;
        if (event) {
          if (event.type === 'matrix-end') matrixEnded = true;
          this.applyEvent(state, target, event);
          return;
        }
        // The harness prints `[evals] fatal: <Error>` then a stack; the
        // first fatal line is the sentence worth showing a person.
        if (!fatalLine && /\bfatal:/.test(line)) fatalLine = line;
        if (stream === 'stderr' || /^\[evals\]/.test(line)) {
          errorTail.push(line);
          if (errorTail.length > 8) errorTail.shift();
        }
        this.appendLog(state, stream === 'stderr' ? `[stderr] ${line}` : line);
      },
    });
    state.proc = proc;
    const exit = await proc.exited;
    await logWrites;
    state.proc = undefined;
    target.currentTrial = undefined;
    target.finishedAt = new Date().toISOString();

    if (state.cancelRequested) {
      target.status = 'cancelled';
    } else if (this.stopping) {
      target.status = 'interrupted';
    } else if (matrixEnded || exit.code === 0 || exit.code === 1) {
      // Exit 1 is "some trial failed" — a finished measurement, not an error.
      target.status = 'completed';
    } else {
      target.status = 'failed';
      target.error =
        exit.code === 3
          ? 'The preflight check refused this model: it could not load, call tools, or run fast enough on this computer. See the log for the probe results.'
          : (exit.error ??
            (fatalMessage(fatalLine) ||
              lastMeaningful(errorTail) ||
              `The eval harness stopped unexpectedly (exit ${exit.code ?? exit.signal}).`));
    }
    this.emitJob(state);
    await this.persist(state);
  }

  private applyEvent(
    state: JobState,
    target: EvalJobTargetProgress,
    event: EvalHarnessEvent,
  ): void {
    switch (event.type) {
      case 'plan':
        target.plannedTrials = event.totalTrials;
        break;
      case 'preflight':
        target.preflight = {
          admitted: event.admitted,
          ...(event.decodeTokensPerSec !== undefined
            ? { decodeTokensPerSec: event.decodeTokensPerSec }
            : {}),
          ...(event.skippedReason ? { skippedReason: event.skippedReason } : {}),
        };
        break;
      case 'trial-start':
        target.currentTrial = {
          scenarioId: event.scenarioId,
          trialId: event.trialId,
          trialIndex: event.trialIndex,
          startedAt: event.startedAt,
        };
        void this.opts.history
          ?.log({
            kind: 'eval.trial.started',
            summary: `eval ${event.scenarioId} / ${target.modelId} started`,
            details: {
              jobId: state.job.id,
              trialId: event.trialId,
              scenarioId: event.scenarioId,
              modelId: target.modelId,
              provider: target.provider,
            },
          })
          .catch(() => {});
        break;
      case 'trial-end':
        target.completedTrials += 1;
        if (event.success) target.passedTrials += 1;
        if (target.currentTrial?.trialId === event.trialId) target.currentTrial = undefined;
        void this.opts.history
          ?.log({
            kind: 'eval.trial.completed',
            summary: `eval ${event.scenarioId}/${target.modelId} ${event.success ? 'PASSED' : 'FAILED'}`,
            details: {
              jobId: state.job.id,
              trialId: event.trialId,
              scenarioId: event.scenarioId,
              modelId: target.modelId,
              provider: target.provider,
              success: event.success,
              reason: event.reason,
              durationMs: event.durationMs,
              ...(event.failureClass ? { failureClass: event.failureClass } : {}),
              ...(event.composite !== undefined ? { composite: event.composite } : {}),
            },
          })
          .catch(() => {});
        void this.persist(state);
        break;
      case 'matrix-end':
        break;
    }
    this.emitJob(state);
  }

  /**
   * Hold a device-bound target while another eval owns the device. Returns
   * false when the job was cancelled (or the daemon is stopping) meanwhile.
   */
  private async waitForDevice(state: JobState): Promise<boolean> {
    const holder = () => (this.opts.deviceLockHolder ?? defaultDeviceLockHolder)();
    let owner = holder();
    while (owner) {
      if (state.cancelRequested || this.stopping) return false;
      if (state.job.status !== 'waiting-for-device' || state.job.waitingOn !== owner) {
        state.job.waitingOn = owner;
        this.update(state, 'waiting-for-device');
        await this.persist(state);
      }
      await new Promise<void>((resolveWait) => {
        const timer = setTimeout(resolveWait, this.opts.devicePollMs ?? DEVICE_POLL_MS);
        state.wake = () => {
          clearTimeout(timer);
          resolveWait();
        };
      });
      state.wake = undefined;
      owner = holder();
    }
    if (state.job.waitingOn) state.job.waitingOn = undefined;
    return !(state.cancelRequested || this.stopping);
  }

  private stopProcess(state: JobState): void {
    const proc = state.proc;
    if (!proc) return;
    try {
      // The harness finalizes the current trial and tears down its daemon on
      // SIGTERM; only a harness that ignores it is killed with its tree.
      proc.child.kill('SIGTERM');
    } catch {
      // already gone
    }
    const timer = setTimeout(
      () => killProcessTree(proc.child),
      this.opts.stopGraceMs ?? STOP_GRACE_MS,
    );
    void proc.exited.finally(() => clearTimeout(timer));
  }

  // ── Bookkeeping ───────────────────────────────────────────────────────

  private update(state: JobState, status: EvalJob['status']): void {
    state.job.status = status;
    if (status !== 'waiting-for-device') state.job.waitingOn = undefined;
    this.emitJob(state);
  }

  private finishJob(state: JobState, status: EvalJob['status']): void {
    state.job.finishedAt = new Date().toISOString();
    for (const target of state.job.targets) target.currentTrial = undefined;
    this.update(state, status);
  }

  private appendLog(state: JobState, line: string): void {
    state.log.push(line);
    if (state.log.length > LOG_RING_LINES) state.log.splice(0, state.log.length - LOG_RING_LINES);
    for (const listener of state.listeners) listener({ type: 'log', line });
  }

  private emitJob(state: JobState): void {
    if (state.listeners.size === 0) return;
    const job = snapshot(state.job);
    for (const listener of state.listeners) listener({ type: 'job', job });
  }

  private persist(state: JobState): Promise<void> {
    // Serialize the record at call time, write in call order.
    const body = `${JSON.stringify(state.job, null, 2)}\n`;
    const file = join(state.job.dir, 'job.json');
    const tmp = `${file}.${process.pid}.tmp`;
    state.persisting = state.persisting.then(async () => {
      try {
        await mkdir(state.job.dir, { recursive: true });
        await writeFile(tmp, body);
        await rename(tmp, file);
      } catch (err) {
        log.warn(`[eval-jobs] could not persist ${state.job.id}: ${String(err)}`);
      }
    });
    return state.persisting;
  }

  private async loadPersisted(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.jobsDir);
    } catch {
      return;
    }
    const loaded: EvalJob[] = [];
    for (const name of names) {
      try {
        const parsed = EvalJobSchema.safeParse(
          JSON.parse(await readFile(join(this.jobsDir, name, 'job.json'), 'utf8')),
        );
        if (parsed.success) loaded.push(parsed.data);
      } catch {
        // not a job folder
      }
    }
    loaded.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const job of loaded) {
      const state: JobState = {
        job,
        log: [],
        listeners: new Set(),
        cancelRequested: false,
        persisting: Promise.resolve(),
      };
      if (!TERMINAL.has(job.status)) {
        // Nothing survives a daemon restart: the harness was our child.
        for (const target of job.targets) {
          target.currentTrial = undefined;
          if (target.status === 'running') target.status = 'interrupted';
          if (target.status === 'pending') target.status = 'cancelled';
        }
        job.status = 'interrupted';
        job.waitingOn = undefined;
        job.finishedAt ??= new Date().toISOString();
        await this.persist(state);
      }
      if (!this.jobs.has(job.id)) {
        this.jobs.set(job.id, state);
        this.order.push(job.id);
      }
    }
  }
}

/** The CLI flags for one target of a job. */
export function harnessArgs(spec: EvalJobSpec, target: EvalJobTargetProgress): string[] {
  const args: string[] = [];
  if (spec.suiteId) args.push('--suite', spec.suiteId);
  if (spec.scenarioIds && spec.scenarioIds.length > 0) {
    args.push('--scenarios', spec.scenarioIds.join(','));
  }
  args.push('--count', String(spec.count));
  if (spec.countStrict) args.push('--count-strict');
  args.push('--provider', target.provider, '--model', target.modelId);
  args.push('--runs-dir', target.runDir, '--write-reports', '--events');
  if (spec.imageModelId) args.push('--image-model', spec.imageModelId);
  if (spec.generalistMode) args.push('--generalist', spec.generalistMode);
  if (spec.timeoutMs) args.push('--timeout', String(spec.timeoutMs));
  if (spec.skipPreflight) args.push('--skip-preflight');
  return args;
}

/** `[stderr] [evals] fatal: Error: model not installed` → `model not installed`. */
function fatalMessage(line: string | undefined): string {
  if (!line) return '';
  return line
    .replace(/^.*?\bfatal:\s*/, '')
    .replace(/^[A-Za-z]*Error:\s*/, '')
    .trim();
}

function lastMeaningful(lines: readonly string[]): string {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.replace(/^\[stderr\]\s*/, '').trim();
    if (line && !/^at\s|^\}|^Node\.js v/.test(line)) return line;
  }
  return '';
}

/**
 * Mirror of the harness's device lock (evals/src/eval-device-lock.ts): an
 * atomic directory holding `owner.json`. Returns a description of a live
 * owner, or null. A dead owner is the harness's to reclaim, not ours.
 */
export function defaultDeviceLockHolder(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.GEZEL_EVAL_ALLOW_CONCURRENT === '1') return null;
  const lockDir = env.GEZEL_EVAL_LOCK_PATH?.trim() || join(homedir(), '.gezel-eval-device.lock');
  const ownerFile = join(lockDir, 'owner.json');
  if (!existsSync(ownerFile)) return null;
  try {
    const owner = JSON.parse(readFileSync(ownerFile, 'utf8')) as {
      pid?: number;
      command?: string;
      startedAt?: string;
    };
    if (typeof owner.pid !== 'number') return null;
    try {
      process.kill(owner.pid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') return null;
    }
    const since = owner.startedAt ? ` since ${owner.startedAt}` : '';
    return `another eval (pid ${owner.pid}${since})`;
  } catch {
    return null;
  }
}
