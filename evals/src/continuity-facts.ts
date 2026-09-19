import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Continuity facts — what a trial did between "started" and "passed/failed":
 * how many steps it walked, how many sessions it took to walk them, how
 * often the context was compacted, whether a fanout spawned and re-joined,
 * and whether the runtime's budgets tripped. The generalist-mode A/B is
 * decided on these as much as on pass rate, and none of them existed in
 * `facts.json` before.
 *
 * Every number is derived from artifacts the harness already captures:
 * `history.jsonl` + `project-history/*.jsonl` (deduped by event id — the
 * root log mirrors project events), the `sessions/*.json` dumps, the
 * `daemon.log`, and the captured task state. Policy-free: the postmortem and
 * the A/B bin decide what a number means.
 *
 * Two facts about the raw data shape this module:
 *  - `chat.compacted` history covers only between-turn LLM compaction;
 *    mid-turn condensation and FORCE-FIT write no history event, so they are
 *    counted from their `daemon.log` markers.
 *  - A session's `stepId` is re-pinned in place as a generalist task walks
 *    its steps, so the session dump names only the LAST step. The
 *    session-to-step join is the `tool.called` event, whose details carry
 *    `sessionId`, `taskRef` and `stepId` at the time of the call.
 */

export interface ContinuityStepFacts {
  ref: string;
  stepId: string;
  activatedAt: string | null;
  completedAt: string | null;
  ms: number | null;
  gateRejections: number;
  toolCalls: number;
  sessionIds: string[];
}

export interface ContinuityFacts {
  /** `--generalist` setting the trial ran with; null when the run left the daemon default. */
  mode: 'auto' | 'on' | 'off' | null;
  engine: string | null;
  /** Tasks per resolved execution mode, from the `generalist-mode resolved=` log marker. */
  resolvedModes: { generalist: number; stepwise: number };
  steps: {
    /** Distinct steps that were active at some point: events plus the captured task records. */
    activated: number;
    /**
     * Raw `task.step.activated` events. The runtime emits one only when it
     * RE-activates a step (a gate loop, a re-drive); the entry step goes
     * active at creation with no event, and a book that passes first time
     * emits none. So this is a re-activation count, not a walk length —
     * the dry run of 2026-09-18 showed "2 steps" for a task that never left
     * step one, and "0" for a fanout whose five children all ran.
     */
    activationEvents: number;
    completed: number;
    gateApprovals: number;
    gateRejections: number;
    redrives: number;
    perStep: ContinuityStepFacts[];
    medianStepMs: number | null;
  };
  sessions: {
    total: number;
    taskScoped: number;
    byGezel: Record<string, number>;
    perTask: Record<string, number>;
    /** Sessions whose tool calls span two or more step ids — the generalist signature. */
    reusedAcrossSteps: number;
    /** `task-session continuity: reusing` log lines (one transcript carried into the next step). */
    continuityReuses: number;
    /** `generalist continuity broken` log lines (a provider/model change forced a fresh session). */
    continuityBreaks: number;
    sessionsPerStep: number | null;
    maxMessages: number;
    maxContextFill: number | null;
    resumeFailures: number;
  };
  compaction: {
    /** False for providers that compact inside their own process (CLI wrappers, Copilot): zeros are `n/a`, not "none". */
    observable: boolean;
    betweenTurn: number;
    midTurn: number;
    forceFit: number;
    compactStarts: number;
    compactFailed: number;
    firstTurnPrefixOver: number;
    loopHalts: number;
    maxContextFill: number | null;
  };
  fanout: {
    hosts: number;
    childrenSpawned: number;
    childrenCompleted: number;
    childrenFailed: number;
    barrierHolds: number;
    barrierReleases: number;
    barrierReleaseFailures: number;
    skipped: number;
  };
  budget: {
    taskBudgetSoft: number;
    taskBudgetHard: number;
    toolRepeatAborts: number;
  };
}

export interface ContinuityHistoryEvent {
  id?: string;
  kind: string;
  at?: string;
  details?: Record<string, unknown>;
}

export interface ContinuitySession {
  id: string;
  gezelId?: string;
  taskRef?: string;
  stepId?: string;
  messages?: Array<{ role?: string; synthetic?: string; toolCalls?: unknown[] }>;
  compactionCount?: number;
  contextEstimatedTokens?: number;
  contextWindow?: number;
  resumeFailed?: boolean;
}

export interface ContinuityTask {
  ref?: string;
  status?: string;
  createdAt?: string;
  activeStepId?: string;
  parentTaskRef?: string;
  spawnsCraftbook?: unknown;
  fanout?: unknown;
  craftbook?: { steps?: Array<{ id?: string; completedAt?: string }> };
}

export interface ContinuityInputs {
  result: { generalistMode?: string; engine?: string };
  historyEvents: ContinuityHistoryEvent[];
  sessions: ContinuitySession[];
  daemonLog: string;
  tasks: ContinuityTask[];
}

/** Providers whose compaction happens outside the daemon's view. */
const UNOBSERVABLE_COMPACTION_ENGINES = new Set(['anthropic-cli', 'codex-cli', 'copilot']);

function countMatches(text: string, re: RegExp): number {
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
  return (text.match(new RegExp(re.source, flags)) ?? []).length;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Drop duplicate events (the root log mirrors project events) by id, else by shape. */
export function dedupeHistoryEvents(events: ContinuityHistoryEvent[]): ContinuityHistoryEvent[] {
  const seen = new Set<string>();
  const out: ContinuityHistoryEvent[] = [];
  for (const event of events) {
    const key =
      event.id ?? `${event.kind}|${event.at ?? ''}|${JSON.stringify(event.details ?? {})}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(event);
  }
  return out;
}

export function summarizeContinuity(input: ContinuityInputs): ContinuityFacts {
  const events = dedupeHistoryEvents(input.historyEvents).sort((a, b) =>
    (a.at ?? '').localeCompare(b.at ?? ''),
  );
  const log = input.daemonLog;

  const perStep = new Map<string, ContinuityStepFacts>();
  const stepKey = (ref: string, stepId: string) => `${ref}|${stepId}`;
  const stepFor = (ref: string, stepId: string): ContinuityStepFacts => {
    const key = stepKey(ref, stepId);
    let entry = perStep.get(key);
    if (!entry) {
      entry = {
        ref,
        stepId,
        activatedAt: null,
        completedAt: null,
        ms: null,
        gateRejections: 0,
        toolCalls: 0,
        sessionIds: [],
      };
      perStep.set(key, entry);
    }
    return entry;
  };
  let activated = 0;
  let completed = 0;
  let gateApprovals = 0;
  let gateRejections = 0;
  let redrives = 0;
  let betweenTurn = 0;
  let childrenSpawnedEvents = 0;
  const materializedChildren = new Set<string>();
  const sessionSteps = new Map<string, Set<string>>();
  for (const event of events) {
    const d = event.details ?? {};
    const ref = str(d.ref) ?? str(d.taskRef);
    const stepId = str(d.stepId);
    switch (event.kind) {
      case 'task.step.activated': {
        activated += 1;
        // The latest activation wins: a gate loop re-activates the same
        // step, and the duration that matters is the final pass.
        if (ref && stepId) stepFor(ref, stepId).activatedAt = event.at ?? null;
        break;
      }
      case 'task.step.completed': {
        completed += 1;
        if (ref && stepId) stepFor(ref, stepId).completedAt = event.at ?? null;
        break;
      }
      case 'task.step.gated': {
        if (d.decision === 'reject') {
          gateRejections += 1;
          if (ref && stepId) stepFor(ref, stepId).gateRejections += 1;
        } else if (d.decision === 'approve') {
          gateApprovals += 1;
        }
        break;
      }
      case 'task.step.redriven':
        redrives += 1;
        break;
      case 'chat.compacted':
        betweenTurn += 1;
        break;
      case 'task.instance.spawned':
        childrenSpawnedEvents += 1;
        break;
      case 'task.fanout.materialized': {
        for (const child of Array.isArray(d.childRefs) ? d.childRefs : []) {
          if (typeof child === 'string') materializedChildren.add(child);
        }
        break;
      }
      case 'tool.called': {
        const sessionId = str(d.sessionId);
        if (ref && stepId) {
          const entry = stepFor(ref, stepId);
          entry.toolCalls += 1;
          if (sessionId && !entry.sessionIds.includes(sessionId)) entry.sessionIds.push(sessionId);
          if (sessionId) {
            const steps = sessionSteps.get(sessionId) ?? new Set<string>();
            steps.add(stepKey(ref, stepId));
            sessionSteps.set(sessionId, steps);
          }
        }
        break;
      }
      default:
        break;
    }
  }
  // The captured task records are the authoritative walk: a completed step
  // was active, the active step is active, and for a linear run the entry
  // step went active at creation and each later step when its predecessor
  // completed. Event-derived stamps win where both exist.
  const activationEvents = activated;
  for (const task of input.tasks) {
    const ref = task.ref;
    const recordSteps = task.craftbook?.steps ?? [];
    if (!ref || recordSteps.length === 0) continue;
    let predecessorCompletedAt: string | null = task.createdAt ?? null;
    for (const step of recordSteps) {
      const done = str(step.completedAt);
      const active = task.activeStepId === step.id;
      if (!step.id || (!done && !active)) {
        predecessorCompletedAt = null;
        continue;
      }
      const entry = stepFor(ref, step.id);
      if (done && !entry.completedAt) entry.completedAt = done;
      if (!entry.activatedAt && predecessorCompletedAt) entry.activatedAt = predecessorCompletedAt;
      predecessorCompletedAt = done;
    }
  }
  activated = perStep.size;
  completed = [...perStep.values()].filter((entry) => entry.completedAt !== null).length;
  for (const entry of perStep.values()) {
    if (entry.activatedAt && entry.completedAt) {
      const ms = Date.parse(entry.completedAt) - Date.parse(entry.activatedAt);
      entry.ms = Number.isFinite(ms) && ms >= 0 ? ms : null;
    }
  }
  const stepList = [...perStep.values()];

  const byGezel: Record<string, number> = {};
  const perTask: Record<string, number> = {};
  let taskScoped = 0;
  let maxMessages = 0;
  let resumeFailures = 0;
  let loopHalts = 0;
  let sessionFill: number | null = null;
  for (const session of input.sessions) {
    const gezel = session.gezelId ?? 'unknown';
    byGezel[gezel] = (byGezel[gezel] ?? 0) + 1;
    if (session.taskRef) {
      taskScoped += 1;
      perTask[session.taskRef] = (perTask[session.taskRef] ?? 0) + 1;
    }
    const messages = session.messages ?? [];
    maxMessages = Math.max(maxMessages, messages.length);
    if (session.resumeFailed) resumeFailures += 1;
    if (messages.some((m) => m.synthetic === 'context-loop-halt')) loopHalts += 1;
    if (session.contextEstimatedTokens && session.contextWindow) {
      const fill = session.contextEstimatedTokens / session.contextWindow;
      sessionFill = sessionFill === null ? fill : Math.max(sessionFill, fill);
    }
  }
  let reusedAcrossSteps = 0;
  for (const steps of sessionSteps.values()) if (steps.size >= 2) reusedAcrossSteps += 1;

  let logFill: number | null = null;
  for (const m of log.matchAll(/COMPACT-START tokens=(\d+)\/(\d+)/g)) {
    const fill = Number(m[1]) / Number(m[2]);
    if (Number.isFinite(fill)) logFill = logFill === null ? fill : Math.max(logFill, fill);
  }
  const maxContextFill =
    sessionFill === null
      ? logFill
      : logFill === null
        ? sessionFill
        : Math.max(sessionFill, logFill);
  let childrenFromLog = 0;
  for (const m of log.matchAll(/\[fanout\] \S+ step "[^"]+": spawned (\d+) child/g)) {
    childrenFromLog += Number(m[1]);
  }

  const children = input.tasks.filter((t) => t.parentTaskRef);
  const hostRefs = new Set<string>();
  for (const t of input.tasks) {
    if ((t.spawnsCraftbook || t.fanout) && t.ref) hostRefs.add(t.ref);
  }
  for (const t of children) if (t.parentTaskRef) hostRefs.add(t.parentTaskRef);

  const engine = input.result.engine ?? null;
  const mode =
    input.result.generalistMode === 'auto' ||
    input.result.generalistMode === 'on' ||
    input.result.generalistMode === 'off'
      ? input.result.generalistMode
      : null;

  return {
    mode,
    engine,
    resolvedModes: {
      generalist: countMatches(log, /generalist-mode resolved=generalist\b/),
      stepwise: countMatches(log, /generalist-mode resolved=stepwise\b/),
    },
    steps: {
      activated,
      activationEvents,
      completed,
      gateApprovals,
      gateRejections,
      redrives,
      perStep: stepList,
      medianStepMs: median(stepList.flatMap((s) => (s.ms === null ? [] : [s.ms]))),
    },
    sessions: {
      total: input.sessions.length,
      taskScoped,
      byGezel,
      perTask,
      reusedAcrossSteps,
      continuityReuses: countMatches(log, /task-session continuity: reusing/),
      continuityBreaks: countMatches(log, /generalist continuity broken/),
      sessionsPerStep: activated > 0 ? taskScoped / activated : null,
      maxMessages,
      maxContextFill: sessionFill,
      resumeFailures,
    },
    compaction: {
      observable: engine === null ? true : !UNOBSERVABLE_COMPACTION_ENGINES.has(engine),
      betweenTurn,
      midTurn: countMatches(log, /deterministic mid-loop compaction/),
      forceFit: countMatches(log, /FORCE-FIT truncated=/),
      compactStarts: countMatches(log, /COMPACT-START/),
      compactFailed: countMatches(log, /COMPACT-END[^\n]*\bnope\b/),
      firstTurnPrefixOver: countMatches(log, /FIRST-TURN-PREFIX/),
      loopHalts,
      maxContextFill,
    },
    fanout: {
      hosts: hostRefs.size,
      childrenSpawned: Math.max(childrenSpawnedEvents, materializedChildren.size, childrenFromLog),
      childrenCompleted: children.filter((t) => t.status === 'complete').length,
      childrenFailed: children.filter(
        (t) => t.status === 'canceled' || t.status === 'failed' || t.status === 'paused',
      ).length,
      barrierHolds: countMatches(log, /holding dispatch — \d+ child/),
      barrierReleases: countMatches(log, /re-dispatching active step/),
      barrierReleaseFailures: countMatches(log, /fanout barrier release failed/),
      skipped: countMatches(log, /\[fanout\][^\n]*skipping fanout/),
    },
    budget: {
      taskBudgetSoft: countMatches(log, /\[task-budget\] \S+ soft threshold/),
      taskBudgetHard: countMatches(log, /\[task-budget\] \S+ HARD threshold/),
      toolRepeatAborts: countMatches(log, /aborting — `/),
    },
  };
}

function readJsonFile<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

function readJsonLines<T>(path: string): T[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
      /* skip a torn line */
    }
  }
  return out;
}

function readTasks(runDir: string): ContinuityTask[] {
  const state = readJsonFile<{ tasks?: { tasks?: ContinuityTask[] } | ContinuityTask[] }>(
    join(runDir, 'state.json'),
  );
  const raw = state?.tasks;
  const live = Array.isArray(raw) ? raw : raw && Array.isArray(raw.tasks) ? raw.tasks : [];
  const historyDir = join(runDir, 'recording', 'task-history');
  const done: ContinuityTask[] = [];
  if (existsSync(historyDir)) {
    for (const name of readdirSync(historyDir).filter((n) => n.endsWith('.json'))) {
      const parsed = readJsonFile<ContinuityTask | ContinuityTask[]>(join(historyDir, name));
      if (!parsed) continue;
      done.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    }
  }
  // A task appears live AND in history around the moment it settled; the
  // settled record wins.
  const byRef = new Map<string, ContinuityTask>();
  for (const t of [...live, ...done]) byRef.set(t.ref ?? `#${byRef.size}`, t);
  return [...byRef.values()];
}

/**
 * Read a trial directory and summarize it. Returns null when the directory
 * holds nothing the summary could speak to (a pre-history run dir), so
 * `facts.json` stays byte-identical for old trials.
 */
export function summarizeContinuityForRunDir(
  runDir: string,
  result: { generalistMode?: string; engine?: string },
): ContinuityFacts | null {
  const historyEvents = readJsonLines<ContinuityHistoryEvent>(join(runDir, 'history.jsonl'));
  const projectHistoryDir = join(runDir, 'project-history');
  if (existsSync(projectHistoryDir)) {
    for (const name of readdirSync(projectHistoryDir).filter((n) => n.endsWith('.jsonl'))) {
      historyEvents.push(...readJsonLines<ContinuityHistoryEvent>(join(projectHistoryDir, name)));
    }
  }
  const sessions: ContinuitySession[] = [];
  const sessionsDir = join(runDir, 'sessions');
  if (existsSync(sessionsDir)) {
    for (const name of readdirSync(sessionsDir).filter((n) => n.endsWith('.json'))) {
      const parsed = readJsonFile<ContinuitySession>(join(sessionsDir, name));
      if (parsed?.id) sessions.push(parsed);
    }
  }
  let daemonLog = '';
  try {
    daemonLog = readFileSync(join(runDir, 'daemon.log'), 'utf8');
  } catch {
    daemonLog = '';
  }
  if (historyEvents.length === 0 && sessions.length === 0 && !daemonLog && !result.generalistMode) {
    return null;
  }
  return summarizeContinuity({
    result,
    historyEvents,
    sessions,
    daemonLog,
    tasks: readTasks(runDir),
  });
}
