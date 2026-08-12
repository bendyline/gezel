import {
  type ChatSessionSummary,
  type Project,
  type ProjectNudgeConfig,
  type Task,
  type TaskCraftbookStep,
  type WorkshopTempo,
  createLogger,
  getEngagementMode,
  getWorkshopTempo,
  isProactiveAllowed,
  isSchedulingAllowed,
  localDateKey,
  projectAllowsAmbientWork,
  projectWorkspaceWritable,
  workshopTempoDefaults,
} from '@bendyline/gezel';
import type { ChatManager } from '../chat/manager.js';
import type { ActivityTracker } from '../fs/activity-tracker.js';
import type { Store } from '../fs/store.js';
import {
  buildPlateauDiagnosisNote,
  buildStageOneNudge,
  buildStageTwoNudge,
  plateauScore,
  stageForPlateau,
} from './gate-escalation.js';
import type { TaskManager } from './manager.js';

const log = createLogger('tasks');

export interface SchedulerOptions {
  manager: TaskManager;
  /** Required for the project-nudge sweep. Omit to disable nudges. */
  chat?: ChatManager;
  /** Required for the project-nudge sweep. Omit to disable nudges. */
  store?: Store;
  intervalMs?: number;
  /** Clock override for tests. */
  now?: () => Date;
  /** Shared process-wide verbose-diagnostics flag. */
  debug?: { isEnabled(): boolean };
  /**
   * Synchronous read of whether the Night Shift *window* is currently open
   * (independent of whether the shift has work / is latched on). A cron
   * host flagged `nightShift.enabled` still advances its cron metadata
   * every tick, but only spawns a child while the window is open — that
   * confines its work to the night without a chicken-and-egg against the
   * "activate only when there's pending work" latch. Defaults to
   * always-open (no confinement).
   */
  isNightShiftWindowOpen?: () => boolean;
  /**
   * Synchronous read of the current night-window day key (see
   * `nightShiftDayKey` in core). Drives the once-per-window guard on
   * night-shift spawn hosts flagged `onceADay`: skip spawning when the
   * host's `lastRunDay` already equals this key, stamp it on spawn.
   * Defaults to the plain local date.
   */
  currentNightShiftDayKey?: () => string;
  /**
   * Stored per-project activity stamps. When wired, the nudge sweep
   * seeds its "last activity" with the tracker's value, so non-chat
   * mutations (tasks, documents, tool calls) count without reloading
   * every session.
   */
  activity?: ActivityTracker;
}

export interface CronTickResult {
  /** Due schedule hosts whose tick metadata was advanced. */
  processedTaskRefs: string[];
  /** Due schedule hosts held by the current engagement mode. */
  heldTaskRefs: string[];
  /** Fresh task instances created from those hosts. */
  spawnedTaskRefs: string[];
  /** Why no due schedules may run under the current engagement mode. */
  holdReason?: 'engagement-off' | 'engagement-paused';
}

/** Hard-coded global defaults applied when nothing's set in config. */
const NUDGE_DEFAULTS = {
  enabled: true,
  rapidIntervalMs: 5 * 60_000,
  slowIntervalMs: 6 * 60 * 60_000,
  recentActivityWindowMs: 60 * 60_000,
  rapidAttemptsBeforeBackoff: 3,
  // Lowered from 30 min — evals capped at 20 min were timing out
  // before the scheduler ever got a chance to nudge a stalled
  // Voorman that wrote a plan-only artifact and then sat. 10 min is
  // still a polite grace for fresh projects (the user is likely
  // still setting things up) while giving the scheduler at least one
  // nudge cycle within a typical eval / short-lived chat session.
  firstNudgeGraceMs: 10 * 60_000,
} as const;

/**
 * How long a poisoned voorman session (lastTurnError set) must sit idle
 * before the ambient nudger attempts a revival turn instead of skipping.
 * Long enough that a genuinely failure-looping session isn't hammered,
 * short enough that an unattended project recovers before external stall
 * watchdogs (the eval runner's soft window is 5 min) give up on it.
 */
const POISONED_REVIVAL_IDLE_MS = 4 * 60_000;

/** Idle step-supervisor defaults (overridable via `config.stuckStep`). */
const STUCK_STEP_DEFAULTS = {
  // Long enough to clear a normal turn plus a full consultation idle-timeout
  // (5 min) so we never re-poke someone who was legitimately mid-answer, but
  // short enough that a genuinely silent step recovers within minutes.
  stallMs: 8 * 60_000,
  // Re-pokes before pausing for a human. Mirrors the gate's default attempt
  // budget — three honest tries, then a person looks.
  maxRedrives: 3,
} as const;

/**
 * Periodic scheduler. Runs two sweeps on every tick:
 *
 *  1. `tickCrons` — records `task.tick` history events for any Active task
 *     whose cron schedule has come due. Metadata-only — tasks aren't
 *     executed autonomously; the tick is a signal a gezel (or future
 *     autoloop) can key off of.
 *
 *  2. `sweepProjectNudges` — for each project with a voorman and recent
 *     activity, fires a cross-gezel nudge from the current Meester to the
 *     voorman asking them to review project health. Rapid cadence (default
 *     5 min) while recently-active; falls back to slow cadence (default
 *     6 h) once rapid nudges go unanswered. Skipped for projects the
 *     ChatManager reports as mid-turn so we don't interrupt the voorman.
 *     Both Chat + Store must be wired at construction; without them the
 *     sweep is a no-op.
 */
export class TaskScheduler {
  private readonly manager: TaskManager;
  private readonly chat?: ChatManager;
  private readonly store?: Store;
  private readonly intervalMs: number;
  private readonly now: () => Date;
  private readonly debug?: { isEnabled(): boolean };
  private readonly isNightShiftWindowOpen: () => boolean;
  private readonly currentNightShiftDayKey: () => string;
  private readonly activity?: ActivityTracker;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  /** Serialize background and user-requested cron passes to prevent double ticks. */
  private cronTickQueue: Promise<void> = Promise.resolve();

  constructor(opts: SchedulerOptions) {
    this.manager = opts.manager;
    this.chat = opts.chat;
    this.store = opts.store;
    this.intervalMs = opts.intervalMs ?? 30_000;
    this.now = opts.now ?? (() => new Date());
    if (opts.debug) this.debug = opts.debug;
    this.isNightShiftWindowOpen = opts.isNightShiftWindowOpen ?? (() => true);
    this.currentNightShiftDayKey = opts.currentNightShiftDayKey ?? (() => localDateKey(this.now()));
    this.activity = opts.activity;
  }

  /**
   * Wire the Keurmeester supervision engine. Set by service.ts after
   * construction (cycle avoidance). When set, the stuck-step sweep
   * consults it before pausing a redrive-exhausted step.
   */
  setKeurmeester(keurmeester: import('../keurmeester/manager.js').KeurmeesterManager): void {
    this.keurmeester = keurmeester;
  }
  private keurmeester?: import('../keurmeester/manager.js').KeurmeesterManager;

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((err) => {
        log.warn('[scheduler] tick failed:', err instanceof Error ? err.message : err);
      });
    }, this.intervalMs);
    // Don't keep the node event loop alive for this alone; the HTTP server is
    // what holds it open.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.tickCrons();
      // Re-drive (or auto-advance) silently-stalled task steps BEFORE the
      // voorman health-check sweep: if a step is genuinely stuck, poking the
      // assignee directly is more targeted than asking the voorman to
      // re-investigate, and advancing one here marks the project mid-turn so
      // the nudge sweep correctly skips it this tick.
      await this.sweepStuckSteps();
      await this.sweepProjectNudges();
    } finally {
      this.running = false;
    }
  }

  /**
   * Re-drive task steps that went silent. The TaskRunner dispatches ONE
   * turn per step activation; nothing else re-drives an assignee who took
   * that turn but never produced the deliverable or advanced (parked on a
   * consultation, aborted, or just stopped). For each active, non-terminal,
   * gezel-owned step whose assignee is idle and which has been quiet past
   * `stallMs`, this either:
   *
   *   1. AUTO-ADVANCES when the deliverable already clears the gate — the
   *      idle-time twin of `ChatManager.maybeAutoAdvanceOnObservableProgress`
   *      (which only fires at end-of-turn); or
   *   2. RE-NUDGES the assignee in their own session to continue the step,
   *      up to `maxRedrives` times; then
   *   3. PAUSES the task for a human once the budget is spent.
   *
   * Gated by engagement mode (off under `reactive`/`off`) and per-project
   * ambient-work status, like cron ticks. A no-op without Chat + Store.
   */
  async sweepStuckSteps(): Promise<void> {
    if (!this.chat || !this.store) return;
    const config = await this.store.readConfig();
    // Autonomous re-drive is scheduling-class activity (it spawns model
    // turns), so it's off under reactive/off — same gate as cron ticks.
    if (!isSchedulingAllowed(config)) return;
    const cfg = config.stuckStep ?? {};
    if (cfg.enabled === false) return;
    const stallMs = cfg.stallMs ?? STUCK_STEP_DEFAULTS.stallMs;
    const maxRedrives = cfg.maxRedrives ?? STUCK_STEP_DEFAULTS.maxRedrives;
    const meesterGezelId = config.meesterGezelId;

    let active: Task[] = [];
    try {
      active = await this.manager.list({ status: 'active' });
    } catch {
      return;
    }
    const nowMs = this.now().getTime();
    const ambientCache = new Map<string, boolean>();
    for (const task of active) {
      try {
        await this.maybeDriveStuckStep(task, {
          stallMs,
          maxRedrives,
          meesterGezelId,
          nowMs,
          ambientCache,
        });
      } catch (err) {
        log.warn(
          `[scheduler] stuck-step sweep failed for ${task.ref}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  private async maybeDriveStuckStep(
    task: Task,
    opts: {
      stallMs: number;
      maxRedrives: number;
      meesterGezelId: string | undefined;
      nowMs: number;
      ambientCache: Map<string, boolean>;
    },
  ): Promise<void> {
    if (!this.chat || !this.store) return;
    if (!task.activeStepId) return;
    const step = task.craftbook.steps.find((s) => s.id === task.activeStepId);
    if (!step || step.terminal) return;
    // Only gezel-owned steps are driveable: step assignee → suggested → the
    // task-level assignee. A user-owned step waits for the user, not us.
    const assignee =
      step.assignee?.kind === 'gezel'
        ? step.assignee.gezelId
        : (step.suggestedGezelId ??
          (task.assignee.kind === 'gezel' ? task.assignee.gezelId : undefined));
    if (!assignee) return;

    // Never interfere with live work: someone mid-turn in this project, or
    // the assignee mid-turn anywhere (a parked consultation counts — the
    // asker's turn is still in flight, so we correctly wait it out).
    if (this.chat.isProjectActive(task.projectId)) return;
    if (this.chat.isGezelActive(assignee)) return;

    // Read-only / inactive projects pause all ambient work.
    if (!(await this.ambientAllowed(task.projectId, opts.ambientCache))) return;

    // A pending user question parks the work on the HUMAN, not the model. The
    // step is "stalled" only because its gezel asked something and is waiting
    // for an answer — re-driving it just re-pokes a gezel that can't proceed.
    // Skip until the question is answered, same as `maybeNudge`'s check-in
    // guard (project-scoped). This is the autonomous-nudge half of "asking a
    // question shouldn't block other work — except more voorman/meester pokes."
    const pendingQuestions = await this.store.listProjectQuestions(task.projectId).catch(() => []);
    const unanswered = pendingQuestions.filter((q) => !q.answer).length;
    if (unanswered > 0) {
      log.info(
        `[scheduler] ${task.ref}: skip re-drive — ${unanswered} unanswered user question(s) pending`,
      );
      return;
    }

    // Staleness: the latest of step activation, our own last re-drive, and
    // the assignee's most-recent session activity on THIS task. Keying on
    // session activity means a productive-but-not-advancing turn (partial
    // work written) resets the clock — we only step in once it's truly gone
    // quiet. `landingPoisoned` mirrors the voorman-nudge guard: if the
    // session a re-nudge would land on aborted last turn, re-poking just
    // re-loops, so leave it for a user-driven turn.
    const { taskSessionLastMs, landingPoisoned } = await this.assigneeSessionState(task, assignee);
    const idleSinceMs = Math.max(stepActivityMs(step), taskSessionLastMs);
    if (idleSinceMs === 0) return; // nothing to measure against — don't act blind
    if (opts.nowMs - idleSinceMs < opts.stallMs) return; // not stale yet
    if (landingPoisoned) return;

    // 1. Auto-advance if the deliverable already satisfies the gate. On
    //    'held' the completion gate ran a FRESH rejection this tick — the
    //    assignee just got the verdict, so don't also re-drive. But
    //    'held-frozen' means the deliverable is byte-identical to the
    //    last reject: the damper will never move on its own, so fall
    //    through to the redrive branch with the gate-aware nudge instead
    //    of sweeping this damper forever (the second half of the
    //    silent-plateau gap).
    const adv = await this.manager.tryIdleAutoAdvance(task.projectId, task.num);
    if (adv === 'advanced' || adv === 'held') return;
    const gateFrozen = adv === 'held-frozen';

    // 2. Re-drive, bounded. Budget spent → Keurmeester escalation point:
    //    consult before pausing. An applied verdict earns the step ONE
    //    more re-drive window (budget reset to maxRedrives-1) — then the
    //    next exhaustion pauses for real (the consult's own per-task
    //    budget and cooldown decline a repeat). Stand_down, predicate
    //    misses, and consult failures pause exactly as before.
    const redriveCount = step.redriveCount ?? 0;
    if (redriveCount >= opts.maxRedrives) {
      const consult = this.keurmeester
        ? await this.keurmeester
            .consultTaskStall({
              trigger: 'step_redrive_exhausted',
              triggerSummary: `step re-driven ${redriveCount}/${opts.maxRedrives} times without producing its deliverable; the task is about to pause for help`,
              projectId: task.projectId,
              taskNum: task.num,
              taskRef: task.ref,
              stepId: step.id,
              assigneeGezelId: assignee,
              signals: { redriveCount, maxRedrives: opts.maxRedrives },
            })
            .catch((err: unknown) => {
              log.warn(
                `[scheduler] keurmeester consult threw: ${err instanceof Error ? err.message : err}`,
              );
              return null;
            })
        : null;
      if (consult?.applied) {
        if (consult.action === 'takeover_step') {
          if (consult.takeoverAdvanced) return; // step advanced; nothing left to drive
          // Failed takeover = the whole ladder is spent — pause for a human.
          await this.escalateStuckStep(task, step, assignee, opts.maxRedrives);
          return;
        }
        await this.manager.resetStepRecoveryBudget(task.projectId, task.num, step.id, {
          redriveCount: opts.maxRedrives - 1,
          clearGateAttempts: true,
        });
        log.info(
          `[scheduler] ${task.ref} step "${step.id}": keurmeester ${consult.action} applied — granting one more re-drive window`,
        );
        return;
      }
      await this.escalateStuckStep(task, step, assignee, opts.maxRedrives);
      return;
    }
    // The re-nudge comes from the project's voorman (it's their delegate),
    // falling back to the meester. It must be someone OTHER than the
    // assignee — a self-message just loops.
    const project = await this.store.getProject(task.projectId);
    const sender = project?.voormanGezelId ?? opts.meesterGezelId;
    if (!sender || sender === assignee) return;

    await this.chat.messageGezel({
      fromGezelId: sender,
      toGezelIdOrName: assignee,
      projectId: task.projectId,
      text: gateFrozen ? stuckStepGateNudgeText(task, step) : stuckStepNudgeText(task, step),
      // Resume the exact task-step thread. Without these fields the nudge
      // falls into lobby chat and task tools lose their step-scoped env.
      taskRef: task.ref,
      stepId: step.id,
      // Ambient re-drive — must yield to any user-driven turn on the same
      // provider, like the voorman nudge.
      lane: 'background',
      ambient: true,
    });
    const newCount = await this.manager.recordStepRedrive(task.projectId, task.num, step.id);
    await this.store.historyManager?.log({
      kind: 'task.step.redriven',
      projectId: task.projectId,
      gezelId: assignee,
      summary: `Re-drove stalled step "${step.name}" on ${task.ref} (attempt ${newCount}/${opts.maxRedrives})`,
      details: { ref: task.ref, stepId: step.id, attempt: newCount, maxRedrives: opts.maxRedrives },
    });
    log.info(
      `[scheduler] re-drove stalled step "${step.id}" on ${task.ref} → ${assignee} ` +
        `(attempt ${newCount}/${opts.maxRedrives})`,
    );
  }

  /** Re-drive budget spent: note the stall and pause the task for a human. */
  private async escalateStuckStep(
    task: Task,
    step: TaskCraftbookStep,
    assignee: string,
    maxRedrives: number,
  ): Promise<void> {
    if (!this.store) return;
    // When the step carries a gate-attempt trail, pause with the full
    // diagnosis (what was tried, what the gate said each time) instead of
    // the bare "re-driven N times" note — whoever resumes starts with the
    // investigation done.
    const noteText =
      step.gateAttemptHistory && step.gateAttemptHistory.length >= 2
        ? buildPlateauDiagnosisNote({
            stepName: step.name,
            stepId: step.id,
            trail: step.gateAttemptHistory,
            lastMessage: step.lastGateReject?.message ?? '(no gate verdict recorded)',
          })
        : `# Step stalled — paused for help\n\nStep "${step.name}" (\`${step.id}\`) was re-driven ${maxRedrives}× without producing its deliverable or advancing, and ${assignee} isn't making progress unattended. Pausing the task so you can look — re-assign, clarify the step, or advance it manually, then set it active again.`;
    await this.manager
      .appendNote(task.projectId, task.num, {
        text: noteText,
        author: { kind: 'user' },
        stepId: step.id,
      })
      .catch(() => {});
    await this.manager.setStatus(task.projectId, task.num, 'paused').catch(() => {});
    await this.manager.emitNeedsHelp({
      projectId: task.projectId,
      task,
      stepId: step.id,
      reason: 'step_stalled',
      detail: `Step "${step.name}" was re-driven ${maxRedrives}x without producing its deliverable or advancing.`,
    });
    await this.store.historyManager?.log({
      kind: 'task.step.stalled',
      projectId: task.projectId,
      gezelId: assignee,
      summary: `Paused ${task.ref}: step "${step.name}" stalled after ${maxRedrives} re-drives`,
      details: { ref: task.ref, stepId: step.id, maxRedrives },
    });
    log.warn(
      `[scheduler] ${task.ref} step "${step.id}" stalled after ${maxRedrives} re-drives — pausing`,
    );
  }

  /** Per-project ambient-work status, cached across one sweep. */
  private async ambientAllowed(projectId: string, cache: Map<string, boolean>): Promise<boolean> {
    const hit = cache.get(projectId);
    if (hit !== undefined) return hit;
    const project = await this.store?.getProject(projectId);
    const allowed = project ? projectAllowsAmbientWork(project) : true;
    cache.set(projectId, allowed);
    return allowed;
  }

  /**
   * Inspect the assignee's sessions to decide staleness + poison:
   *   - `taskSessionLastMs` — latest activity across their non-archived
   *     sessions scoped to THIS task (0 if none exist yet).
   *   - `landingPoisoned`   — whether the most-recent non-archived session
   *     in this project (the one a re-nudge lands on via
   *     `ensureOrCreateSession`) aborted its last turn.
   */
  private async assigneeSessionState(
    task: Task,
    assignee: string,
  ): Promise<{ taskSessionLastMs: number; landingPoisoned: boolean }> {
    if (!this.store) return { taskSessionLastMs: 0, landingPoisoned: false };
    let sessions: ChatSessionSummary[] = [];
    try {
      sessions = await this.store.listSessions({ gezelId: assignee });
    } catch {
      return { taskSessionLastMs: 0, landingPoisoned: false };
    }
    let taskSessionLastMs = 0;
    let landingMs = -1;
    let landingPoisoned = false;
    for (const s of sessions) {
      if (s.archived) continue;
      const t = Date.parse(s.lastActivityAt);
      const tm = Number.isFinite(t) ? t : 0;
      if (s.taskRef === task.ref && tm > taskSessionLastMs) taskSessionLastMs = tm;
      if (s.projectId === task.projectId && tm > landingMs) {
        landingMs = tm;
        landingPoisoned = Boolean(s.lastTurnError);
      }
    }
    return { taskSessionLastMs, landingPoisoned };
  }

  async tickCrons(opts: { projectId?: string } = {}): Promise<CronTickResult> {
    const pass = this.cronTickQueue.then(() => this.runCronTickPass(opts));
    this.cronTickQueue = pass.then(
      () => undefined,
      () => undefined,
    );
    return pass;
  }

  private async runCronTickPass(opts: { projectId?: string } = {}): Promise<CronTickResult> {
    const result: CronTickResult = {
      processedTaskRefs: [],
      heldTaskRefs: [],
      spawnedTaskRefs: [],
    };
    let schedulingHoldReason: CronTickResult['holdReason'];
    if (this.store) {
      const config = await this.store.readConfig();
      if (!isSchedulingAllowed(config)) {
        schedulingHoldReason =
          getEngagementMode(config) === 'off' ? 'engagement-off' : 'engagement-paused';
      }
    }
    const active = await this.manager.list({ status: 'active' });
    const nowMs = this.now().getTime();
    // Cache project lookups across this sweep — avoids N disk reads when
    // several crons live in the same project.
    const projectStatusCache = new Map<string, boolean>();
    const allowsAmbient = async (projectId: string): Promise<boolean> => {
      const cached = projectStatusCache.get(projectId);
      if (cached !== undefined) return cached;
      const project = await this.store?.getProject(projectId);
      const allowed = project ? projectAllowsAmbientWork(project) : true;
      projectStatusCache.set(projectId, allowed);
      return allowed;
    };
    for (const task of active) {
      if (opts.projectId && task.projectId !== opts.projectId) continue;
      if (!task.cron?.nextTickAt) continue;
      const fireMs = Date.parse(task.cron.nextTickAt);
      if (!Number.isFinite(fireMs) || fireMs > nowMs) continue;
      if (!(await allowsAmbient(task.projectId))) continue;
      if (schedulingHoldReason) {
        result.holdReason = schedulingHoldReason;
        result.heldTaskRefs.push(task.ref);
        continue;
      }
      try {
        // Always advance cron metadata so we don't fire repeatedly for a
        // past deadline. Spawning a child (if applicable) is a separate
        // step that can be skipped based on overlap policy.
        await this.manager.recordCronTick(task);
        result.processedTaskRefs.push(task.ref);
        // A night-shift cron host advances its schedule normally but only
        // spawns a child while the night-shift window is open — this confines
        // its work to the night. The metadata advance above still runs so we
        // don't fire repeatedly for the same past deadline; the spawned child
        // inherits the night-shift flag (so the runner gates its dispatch to
        // an active shift).
        if (task.nightShift?.enabled === true && !this.isNightShiftWindowOpen()) continue;
        // Once-per-window guard: a night-shift host with `onceADay` spawns
        // at most one child per night window. `lastRunDay` is stamped below
        // at spawn time — the host's placeholder step never completes, so
        // the step-completion stamping path can't reach it.
        const nightOnceKey =
          task.nightShift?.enabled === true && task.nightShift.onceADay
            ? this.currentNightShiftDayKey()
            : null;
        if (nightOnceKey !== null && task.nightShift?.lastRunDay === nightOnceKey) continue;
        if (task.spawnsCraftbook && task.spawnsCraftbook.steps.length > 0) {
          const overlap = task.cron.overlap ?? 'skip';
          if (overlap === 'skip') {
            const activeChildren = await this.manager.listChildren(task.ref, {
              status: 'active',
            });
            if (activeChildren.length > 0) continue;
          }
          const child = await this.manager.spawnChild(task.ref);
          result.spawnedTaskRefs.push(child.ref);
          if (nightOnceKey !== null) {
            await this.manager.recordNightShiftSpawn(task.ref, nightOnceKey);
          }
        }
      } catch (err) {
        log.warn(
          `[scheduler] task ${task.ref} tick failed:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    return result;
  }

  /**
   * One pass over every project with a voorman. For each, decide whether
   * a nudge is due based on (a) when the project was last touched, (b)
   * when we last nudged, and (c) how many consecutive rapid nudges have
   * gone unanswered. Fires at most one nudge per project per sweep.
   */
  async sweepProjectNudges(): Promise<void> {
    if (!this.chat || !this.store) return;
    const projects = await this.store.listProjects();
    if (projects.length === 0) return;
    const config = await this.store.readConfig();
    if (!isProactiveAllowed(config)) return;
    // Workspace writability is per-project now (projectWorkspaceWritable),
    // so the write-blocked guard lives in maybeNudge where the project is
    // known — no global skip here.
    const meesterGezelId = config.meesterGezelId;
    if (!meesterGezelId) return;
    const globalDefaults = config.projectNudge ?? {};
    const tempo = getWorkshopTempo(config);
    const nowMs = this.now().getTime();

    for (const project of projects) {
      try {
        await this.maybeNudge(project, meesterGezelId, globalDefaults, tempo, nowMs);
      } catch (err) {
        log.warn(
          `[scheduler] project ${project.id} nudge failed:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  private async maybeNudge(
    project: Project,
    meesterGezelId: string,
    globalDefaults: ProjectNudgeConfig,
    tempo: WorkshopTempo,
    nowMs: number,
  ): Promise<void> {
    if (!this.chat || !this.store) return;
    if (!project.voormanGezelId) return;
    // Trace at INFO level when no nudge has yet fired for this project
    // OR when something explicitly skips. Once a project has a healthy
    // cadence going we don't need the per-tick trace, so the
    // post-first-nudge case stays gated on the verbose-debug flag to
    // keep production logs quiet.
    const debugOn = this.debug?.isEnabled() === true;
    const noNudgeYet = !project.nudgeState?.lastNudgedAt;
    const trace = (reason: string) => {
      if (debugOn || noNudgeYet) log.info(`[scheduler] ${project.id}: ${reason}`);
    };
    // Read-only / inactive projects pause ambient work — no meester
    // nudges, no auto-step handoffs, no cron ticks. Chat still
    // works; this only gates scheduler-driven activity.
    if (!projectAllowsAmbientWork(project)) {
      // Steady state for stable / read-only / inactive projects: they never
      // nudge, so this fires every tick forever and just restates the
      // project's known status. No diagnostic value — stay silent.
      return;
    }
    // A completion-oriented Meester check-in is counterproductive when
    // gezels can't edit this project's files: an external workingDir
    // without the explicit opt-in, or a project the user set to "edits
    // off". Internal workspaces are writable by default (see
    // projectWorkspaceWritable) — a fresh internal project keeps its
    // nudges even under super-lockdown.
    if (!projectWorkspaceWritable(project)) {
      trace('skip — gezel file edits disabled for this project');
      return;
    }
    // Don't nudge the Meester themselves — meester-as-voorman is a
    // legitimate setup but the self-message case loops.
    if (project.voormanGezelId === meesterGezelId) {
      trace('skip — voorman is the Meester');
      return;
    }

    const cfg = mergeNudgeConfig(project.nudgeConfig, globalDefaults, tempo);
    if (cfg.enabled === false) {
      // This is a durable steady state and it never produces `lastNudgedAt`,
      // so the ordinary first-nudge trace would repeat every 30 seconds
      // forever. Keep it available in explicit debug mode only.
      if (debugOn) log.info(`[scheduler] ${project.id}: skip — nudges disabled for this project`);
      return;
    }
    // Skip the nudge if either (a) someone's mid-turn anywhere in this
    // project or (b) the voorman themselves is mid-turn on any session,
    // not just this project's. A gezel can only think about one thing
    // at a time; nudging a voorman who is currently processing a
    // message on a different project just throws "already in flight".
    if (this.chat.isProjectActive(project.id)) {
      trace('skip — a session in this project is mid-turn');
      return;
    }
    if (this.chat.isGezelActive(project.voormanGezelId)) {
      trace(`skip — voorman ${project.voormanGezelId} is mid-turn elsewhere`);
      return;
    }
    // One task listing serves three gates: the at-rest self-heal and the
    // delegate-busy guard here, plus the organic-activity scan further
    // down that drives the rapid-nudge backoff.
    let projectTasks: Task[] = [];
    try {
      projectTasks = await this.manager.list({ projectId: project.id });
    } catch {
      // Best-effort — without the task list the task-driven gates simply
      // don't trigger, and the remaining gates decide.
    }
    const activeTasks = projectTasks.filter((t) => t.status === 'active');

    // Self-heal: the project has tasks but none active, yet its status is
    // still `active` (the status gate above already let it through).
    // `maybeStabilizeProject` normally fires when a task closes, but a
    // project can get stuck `active` with no active tasks — a close that
    // raced, or one that predates the stable lifecycle — and a voorman
    // re-closing the task is a no-op that never re-runs stabilization.
    // Without this check the meester nudges a finished project forever
    // (wild-caught, qwen3.6 "Space Shooter Arcade"): bring it
    // to rest instead of nudging.
    if (projectTasks.length > 0 && activeTasks.length === 0) {
      // A draft is pending work awaiting the user's activation, not a
      // finished project: don't stabilize it, and don't nudge the voorman
      // about a plan that isn't running yet — just skip this tick.
      if (projectTasks.some((t) => t.status === 'draft')) {
        trace('skip — only draft task(s) await activation; not nudging or stabilizing');
        return;
      }
      await this.manager.maybeStabilizeProject(project.id);
      trace('skip — no active tasks; project brought to rest (stable) instead of nudged');
      return;
    }

    // Skip while a delegate is actively working the deliverable. When an
    // active task in this project is assigned to a non-voorman gezel who
    // is currently mid-turn (e.g. a builder writing the file the voorman
    // just handed off), pinging the voorman "anything stuck?" is noise —
    // the work is in flight in someone else's session, and the nudge
    // just spawns a redundant re-planning turn. Wild-caught
    // (Space Shooter Arcade): the foreman re-delegated the same file on
    // every check-in while the assignee was still writing it.
    const busy = activeTasks.find(
      (t) =>
        t.assignee.kind === 'gezel' &&
        t.assignee.gezelId !== project.voormanGezelId &&
        this.chat?.isGezelActive(t.assignee.gezelId) === true,
    );
    if (busy && busy.assignee.kind === 'gezel') {
      trace(`skip — assignee ${busy.assignee.gezelId} is mid-turn on ${busy.ref}`);
      return;
    }
    // Queue backpressure: if the voorman's provider already has
    // INTERACTIVE work queued up (task handoffs mid-flight, mention
    // fan-outs, user-driven turns), piling a meester-nudge on top just
    // lengthens the backlog. Let user-facing work drain first.
    //
    // Background-lane items (icon / about generation for newly-created
    // gezels, memory consolidation, summarization) deliberately do NOT
    // count: they're internal bookkeeping that runs whenever the model
    // has spare cycles. Counting them here was the bug that wedged
    // ambient nudges right after a `start_project` call — three new
    // gezels' icon+about backgrounds easily put the queue at 4-6
    // background items, which exceeded the old `queuedInteractive +
    // queuedBackground >= 2` threshold and silently skipped every
    // nudge until the bootstrap drained (which on small local models
    // could be many minutes). The nudge itself is also `lane:
    // 'background'` — appending it to a queue of background work just
    // makes it the next-in-line, which is fine.
    try {
      const providerName = await this.chat.providerForGezel(project.voormanGezelId);
      const provider = this.chat.getProviderIfReady(providerName);
      const snap = provider?.queue?.snapshot();
      if (snap && snap.queuedInteractive >= 2) {
        trace(
          `skip — voorman's provider (${providerName}) has ${snap.queuedInteractive} interactive item(s) queued`,
        );
        return;
      }
    } catch {
      // If provider resolution fails here, just proceed — the nudge
      // itself will surface any real error.
    }

    // If the project already has unanswered questions posted to the user,
    // skip the nudge. The voorman is explicitly waiting on a human
    // decision surfaced through the structured-question UI (Home pane
    // + chat card + Home tab badge) — pinging them to "check in" is
    // just going to prompt "I'm still waiting," which is noise.
    const pendingQuestions = await this.store.listProjectQuestions(project.id).catch(() => []);
    if (pendingQuestions.some((q) => !q.answer)) {
      trace(
        `skip — ${pendingQuestions.filter((q) => !q.answer).length} unanswered question(s) pending`,
      );
      return;
    }

    // Project "last activity" must reflect chat traffic, not just
    // metadata edits. `project.updatedAt` only bumps on explicit config
    // changes (voorman reassigned, about/mission edited, workspace
    // writes); a project that's actively being discussed via chat would
    // silently drop into slow-mode cadence after an hour without it.
    // Take the max of project.updatedAt and the latest session activity
    // across every session scoped to this project.
    const projectUpdatedMs = Date.parse(project.updatedAt);
    let lastActivityMs = Number.isFinite(projectUpdatedMs) ? projectUpdatedMs : 0;
    if (this.activity) {
      const tracked = Date.parse((await this.activity.lastActivityAt(project.id)) ?? '');
      if (Number.isFinite(tracked) && tracked > lastActivityMs) lastActivityMs = tracked;
    }
    // Latest HUMAN message across the project's sessions — feeds the
    // organic-activity scan below. Deliberately separate from
    // `lastActivityMs`: raw session activity includes the voorman's
    // replies to our own nudges.
    let lastHumanMs = 0;
    let voormanLastTurnAborted = false;
    let voormanSessionLastActivityMs = 0;
    let sawVoormanSession = false;
    try {
      const sessions = await this.store.listSessions({ projectId: project.id });
      for (const s of sessions) {
        const t = Date.parse(s.lastActivityAt);
        if (Number.isFinite(t) && t > lastActivityMs) lastActivityMs = t;
        const h = s.lastHumanActivityAt ? Date.parse(s.lastHumanActivityAt) : Number.NaN;
        if (Number.isFinite(h) && h > lastHumanMs) lastHumanMs = h;
        // A nudge lands on the voorman's most-recent NON-ARCHIVED session in
        // this project (ensureOrCreateSession picks `find(!archived)` over
        // the lastActivityAt-desc list). If THAT session's last turn aborted
        // — failure-loop, prose-without-action, context overflow — the
        // session is poisoned: an ambient "anything stuck?" just spawns
        // another doomed turn instead of recovering. `lastTurnError` is set
        // on abort and cleared on the next successful turn, so this only
        // suppresses nudges until a real (user-driven) turn revives it.
        // Wild-caught (qwen3.6 "Space Shooter Arcade"): the
        // meester's check-in hit an already-aborting session and produced a
        // pure repetition loop.
        if (!sawVoormanSession && !s.archived && s.gezelId === project.voormanGezelId) {
          sawVoormanSession = true;
          voormanLastTurnAborted = Boolean(s.lastTurnError);
          const va = Date.parse(s.lastActivityAt);
          voormanSessionLastActivityMs = Number.isFinite(va) ? va : 0;
        }
      }
    } catch {
      /* best-effort — fall through with project.updatedAt alone */
    }
    if (voormanLastTurnAborted) {
      // The permanent "awaiting a user turn" skip assumed an interactive
      // user exists to revive the session. Unattended (autostart daemon,
      // scheduled jobs, evals) that assumption made ONE aborted voorman
      // turn fatal to the whole project: the scheduler never re-drove
      // anything again. Wild-caught core sweep (gemma4-26b-q4 /
      // data-wrangle): an engine mid-stream silence aborted the voorman's
      // recovery turn and every subsequent sweep skipped on this gate.
      // Keep the anti-repetition-loop protection, but bound it: once the
      // poisoned session has been idle past the cooldown, attempt one
      // revival nudge. Success clears lastTurnError; another abort
      // re-poisons and buys another cooldown — worst case one attempted
      // turn per cooldown, never a rapid-fire loop.
      const idleMs = nowMs - voormanSessionLastActivityMs;
      if (voormanSessionLastActivityMs === 0 || idleMs < POISONED_REVIVAL_IDLE_MS) {
        trace(
          `skip — voorman's most-recent session aborted last turn (poisoned; retrying after ${Math.round(POISONED_REVIVAL_IDLE_MS / 60_000)} min idle or a user turn)`,
        );
        return;
      }
      trace(
        `poisoned voorman session idle ${Math.round(idleMs / 60_000)} min ≥ cooldown — attempting revival nudge`,
      );
    }
    const lastNudgedStr = project.nudgeState?.lastNudgedAt;
    const lastNudgedMs = lastNudgedStr ? Date.parse(lastNudgedStr) : 0;

    // First-nudge grace: don't fire the very first nudge until the
    // project has had time to settle in. Without this, a freshly-
    // kicked-off project gets pinged at the 5-minute mark exactly
    // when the voorman is most likely deep in the first task and
    // least likely to benefit from a "checking in" interruption.
    // Once the project has been nudged at least once, this guard no
    // longer applies — re-engagement after a long idle still uses
    // normal cadence keyed off `lastNudgedAt`.
    if (lastNudgedMs === 0 && cfg.firstNudgeGraceMs > 0) {
      const projectCreatedMs = Date.parse(project.createdAt);
      if (Number.isFinite(projectCreatedMs)) {
        const ageMs = nowMs - projectCreatedMs;
        if (ageMs < cfg.firstNudgeGraceMs) {
          trace(
            `skip — project age ${Math.max(0, Math.round(ageMs / 60_000))} min < ` +
              `first-nudge grace ${Math.round(cfg.firstNudgeGraceMs / 60_000)} min`,
          );
          return;
        }
      }
    }

    // Reset the rapid-nudge counter only on ORGANIC activity since the
    // last nudge — a human message in a project session, a task
    // mutation, or a project config edit. Raw `lastActivityMs` is the
    // wrong signal here: the voorman's reply to the nudge itself bumps
    // `lastActivityAt`, so a healthy voorman who answered every check-in
    // ("all done, nothing to do!") reset the counter on every cycle and
    // the rapid→slow backoff never engaged — a project could be pinged
    // every 5 minutes indefinitely (wild-caught, qwen3.6
    // "Space Shooter Arcade"). The backoff is meant to engage when
    // nudges stop producing movement, whether or not they produce words.
    // None of the organic signals are bumped by nudge delivery (nudge
    // state writes deliberately skip `project.updatedAt`), so no buffer
    // window is needed. A nudge reply that actually moves a task DOES
    // reset — that's real movement, and `task.updatedAt` captures it.
    let lastOrganicMs = Math.max(
      Number.isFinite(projectUpdatedMs) ? projectUpdatedMs : 0,
      lastHumanMs,
    );
    for (const t of projectTasks) {
      const tu = Date.parse(t.updatedAt);
      if (Number.isFinite(tu) && tu > lastOrganicMs) lastOrganicMs = tu;
    }
    let consecutiveRapidNudges = project.nudgeState?.consecutiveRapidNudges ?? 0;
    if (lastOrganicMs > lastNudgedMs) {
      consecutiveRapidNudges = 0;
    }

    const recentlyActive =
      Number.isFinite(lastActivityMs) && nowMs - lastActivityMs < cfg.recentActivityWindowMs;
    const inRapidMode = recentlyActive && consecutiveRapidNudges < cfg.rapidAttemptsBeforeBackoff;
    const interval = inRapidMode ? cfg.rapidIntervalMs : cfg.slowIntervalMs;

    if (nowMs - lastNudgedMs < interval) {
      trace(
        `skip — ${Math.round((nowMs - lastNudgedMs) / 1000)}s since last nudge, ` +
          `need ${Math.round(interval / 1000)}s (${inRapidMode ? 'rapid' : 'slow'} mode)`,
      );
      return;
    }

    if (debugOn) {
      trace(
        `firing — ${inRapidMode ? 'rapid' : 'slow'} cadence, ` +
          `recentlyActive=${recentlyActive}, consecutiveRapidNudges=${consecutiveRapidNudges}`,
      );
    }

    // Fire the nudge. Text varies with tempo — `bedrijvig` preserves the
    // historical phrasing so existing installs see no change.
    const nowIsoStr = this.now().toISOString();
    const text = nudgeText(tempo, project.name);

    await this.chat.messageGezel({
      fromGezelId: meesterGezelId,
      toGezelIdOrName: project.voormanGezelId,
      projectId: project.id,
      text,
      // Ambient health-check — must yield to any user-driven turn
      // sharing the same provider. Without this, on a single-slot
      // local model the user's foreground question can sit behind
      // a scheduler nudge in the same `interactive` lane.
      lane: 'background',
      ambient: true,
    });

    // Update nudge state. Don't touch `updatedAt` (that's activity), so
    // write project.json directly rather than going through updateProject.
    await this.store.writeProjectNudgeState(project.id, {
      lastNudgedAt: nowIsoStr,
      consecutiveRapidNudges: consecutiveRapidNudges + 1,
    });

    await this.store.historyManager?.log({
      kind: 'project.nudge.sent',
      projectId: project.id,
      gezelId: project.voormanGezelId,
      summary: `Ambient nudge to ${project.voormanGezelId} (${inRapidMode ? 'rapid' : 'slow'}, ${tempo})`,
      details: {
        mode: inRapidMode ? 'rapid' : 'slow',
        tempo,
        consecutiveRapidNudges: consecutiveRapidNudges + 1,
        intervalMs: interval,
      },
    });
  }
}

/**
 * The most recent moment we know this step was touched by the autopilot:
 * its activation, or our own last re-drive. Session activity is folded in
 * separately by the caller. Returns 0 when neither timestamp is parseable.
 */
function stepActivityMs(step: TaskCraftbookStep): number {
  const candidates = [step.lastActivatedAt, step.lastRedriveAt]
    .map((s) => (s ? Date.parse(s) : Number.NaN))
    .filter((n) => Number.isFinite(n));
  return candidates.length ? Math.max(...candidates) : 0;
}

/**
 * The continuation seed delivered to a stalled assignee's own session. It
 * re-states which step they're on and what's missing, then points at the
 * two moves that close it: write the deliverable, call `advance_task_step`.
 * Deliberately concrete (names the deliverable + the advance tool) — a
 * vague "any update?" is what let the step stall in the first place.
 */
function stuckStepNudgeText(task: Task, step: TaskCraftbookStep): string {
  const deliverable = step.advanceWhen?.file
    ? ` The deliverable \`${step.advanceWhen.file}\`${step.advanceWhen.artifact ? ' (in the artifacts drawer)' : ''} isn't there yet.`
    : '';
  const howTo =
    'Pick up where you left off: follow the step procedure in your prompt, write the deliverable with the tool it names, then call `advance_task_step` to hand off. ' +
    'If you are genuinely blocked, say exactly what you need (or ask the user with `ask_user_question`) instead of going quiet.';
  return `You're still assigned step \`${step.id}\` ("${step.name}") of task ${task.ref}, and it hasn't progressed.${deliverable} ${howTo}`;
}

/**
 * Re-drive text for the frozen-deliverable shape: the file EXISTS but the
 * completion gate keeps rejecting the same bytes. The generic "it isn't
 * there yet" nudge would be false and re-loop the model on writing the
 * same file again — this one carries the gate's actual verdict plus the
 * current escalation directive, so the re-drive lands as a strategy
 * change, not a repetition.
 */
function stuckStepGateNudgeText(task: Task, step: TaskCraftbookStep): string {
  const verdict = step.lastGateReject?.message;
  const file = step.advanceWhen?.file;
  const trail = step.gateAttemptHistory;
  const lastSig = trail?.at(-1)?.signatureHash;
  const score = lastSig ? plateauScore(trail, lastSig) : 1;
  let stage = stageForPlateau(score);
  if (stage === 2 && !file) stage = 1;
  const surface = step.advanceWhen?.artifact ? ('artifact' as const) : ('workspace' as const);
  const directive =
    stage >= 2 && file && verdict
      ? buildStageTwoNudge({ file, failingBullets: verdict, repeats: score, surface })
      : verdict
        ? buildStageOneNudge({
            ...(file ? { file } : {}),
            failingBullets: verdict,
            frozen: true,
            surface,
          })
        : 'Fix the failing checks the gate named in the task notes, then call `advance_task_step` again.';
  return `You're still assigned step \`${step.id}\` ("${step.name}") of task ${task.ref}. The completion gate keeps rejecting the current deliverable — it has not changed since the last rejection.\n\n${directive}`;
}

/**
 * Per-tempo nudge text. Every tempo asks the voorman to evaluate
 * progress against the project's objectives (missionObjectives.md) and,
 * if all of them are met, to mark the project `stable` itself via
 * `update_project`. The meester's voice gets warmer / more pushy as the
 * tempo climbs. `dolle-boel` goes all-caps and ends every message with
 * the "this is fine 🔥" flourish.
 */
function nudgeText(tempo: WorkshopTempo, projectName: string): string {
  switch (tempo) {
    case 'gezellig':
      return `Hey — just checking in on ${projectName}, no rush. Take a moment to compare where things stand against the project's objectives (missionObjectives.md): are we closer, and is anything drifting off-goal? If something's blocked or the plan needs a tweak, let me know. If the objectives are all met and there's nothing left to do, mark the project stable (update_project status: "stable") and say so. Otherwise it's fine to sit.`;
    case 'druk':
      return `${projectName} check-in. Where are we against the objectives (missionObjectives.md)? Measure progress against each goal, then tell me what's done, what's left, and what's blocking the next step. If the plan needs updating, say so. If every objective is met, mark the project stable (update_project status: "stable"). If the user needs to decide something, ask them directly.`;
    case 'dolle-boel':
      return `${projectName.toUpperCase()} — STATUS?? HOW DO WE STACK UP AGAINST THE OBJECTIVES (missionObjectives.md)?? WHAT'S DONE, WHAT'S LEFT, WHAT IS THE BLOCKER?? IS THE PLAN CURRENT?? IS A STEP READY TO ADVANCE?? IF EVERY OBJECTIVE IS MET, MARK IT STABLE (update_project status: "stable")!! If the user needs to decide something, ASK THEM. This is fine. 🔥`;
    default:
      return `Checking in on ${projectName}. Compare current progress against the project's objectives (missionObjectives.md): how far along is each goal, and is the work still aimed at them? Tell me what's done, what's left, whether the plan needs updating, and whether a step is ready to advance. If every objective is met and the project feels done, mark it stable (update_project status: "stable") and say so. If you need the user to make a call on something, please ask them directly.`;
  }
}

interface ResolvedNudgeConfig {
  enabled: boolean;
  rapidIntervalMs: number;
  slowIntervalMs: number;
  recentActivityWindowMs: number;
  rapidAttemptsBeforeBackoff: number;
  firstNudgeGraceMs: number;
}

function mergeNudgeConfig(
  projectOverrides: ProjectNudgeConfig | undefined,
  globalDefaults: ProjectNudgeConfig,
  tempo: WorkshopTempo,
): ResolvedNudgeConfig {
  const tempoBaseline = workshopTempoDefaults(tempo);
  return {
    enabled: projectOverrides?.enabled ?? globalDefaults.enabled ?? NUDGE_DEFAULTS.enabled,
    rapidIntervalMs:
      projectOverrides?.rapidIntervalMs ??
      globalDefaults.rapidIntervalMs ??
      tempoBaseline.rapidIntervalMs,
    slowIntervalMs:
      projectOverrides?.slowIntervalMs ??
      globalDefaults.slowIntervalMs ??
      tempoBaseline.slowIntervalMs,
    recentActivityWindowMs:
      projectOverrides?.recentActivityWindowMs ??
      globalDefaults.recentActivityWindowMs ??
      tempoBaseline.recentActivityWindowMs,
    rapidAttemptsBeforeBackoff:
      projectOverrides?.rapidAttemptsBeforeBackoff ??
      globalDefaults.rapidAttemptsBeforeBackoff ??
      tempoBaseline.rapidAttemptsBeforeBackoff,
    firstNudgeGraceMs:
      projectOverrides?.firstNudgeGraceMs ??
      globalDefaults.firstNudgeGraceMs ??
      tempoBaseline.firstNudgeGraceMs,
  };
}
