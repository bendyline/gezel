import { createHash } from 'node:crypto';
import {
  type GezelConfig,
  type HistoryEvent,
  MEESTER_STATUS_HEADLINE_MAX,
  type MeesterStatusAction,
  type MeesterStatusCta,
  type MeesterStatusModelOutput,
  MeesterStatusModelOutputSchema,
  type MeesterStatusReport,
  type MeesterStatusState,
  type Project,
  type Task,
  createLogger,
  isEngagementAllowed,
  isProactiveAllowed,
  isSchedulingAllowed,
  isSharedLibraryProject,
  projectAllowsAmbientWork,
} from '@bendyline/gezel';
import type { ChatEventBus } from '../chat/events.js';
import type { ActivityTracker } from '../fs/activity-tracker.js';
import type { Store } from '../fs/store.js';
import type { HistoryManager } from '../history/manager.js';
import type { TaskManager } from '../tasks/manager.js';

/**
 * The meester's occasional status report — the dynamic Home greeting.
 * When the install is idle and projects have meaningfully changed, the
 * meester (running on whatever model its frontmatter/config resolves
 * to) surveys every ambient-work project and writes:
 *
 *   - a <120-char headline with a call-to-action, replacing the static
 *     "Good morning." in the greeting band
 *   - a short markdown dashboard report, rendered with squisq
 *   - up to three follow-up actions, materialized as draft tasks for
 *     the project voormans (inert until the user activates them)
 *
 * Same lifecycle discipline as ProjectDigestGenerator: unref'd sweep,
 * gated by config + engagement + idle, idempotent via an input hash —
 * an unchanged workshop never burns a second LLM call. On top of that:
 * a per-local-day run budget (default 4) with a 2h minimum gap, so the
 * runs spread across the day instead of burning in one idle window.
 * Manual runs (`POST /api/meester-status/run`) bypass the idle, budget,
 * and change gates — the user asked.
 */

const log = createLogger('meester-status');

const STARTUP_DELAY_MS = 10 * 60_000;
const SWEEP_INTERVAL_MS = 30 * 60_000;
export const DEFAULT_MAX_RUNS_PER_DAY = 4;
const DEFAULT_CHANGE_WINDOW_HOURS = 24;
const MIN_RUN_GAP_MS = 2 * 60 * 60_000;
const OS_IDLE_THRESHOLD_S = 300;
const ONE_SHOT_TIMEOUT_MS = 180_000;
const PROMPT_INPUT_CAP = 12_000;
const MAX_ACTIONS_PER_RUN = 3;
const MAX_ACTION_KEYS = 50;
const MAX_EVENTS_PER_PROJECT = 15;
const MAX_TASKS_PER_PROJECT = 8;
const MAX_SESSIONS_PER_PROJECT = 5;
const EVENT_WINDOW_MS = 48 * 60 * 60_000;

export type StatusOneShot = (
  prompt: string,
  timeoutMs: number,
  opts: { gezelId: string; jobLabel: string },
) => Promise<string>;

export interface MeesterStatusGeneratorOptions {
  store: Store;
  history: HistoryManager;
  tasks: TaskManager;
  activity: ActivityTracker;
  oneShot: StatusOneShot;
  /** Night shift counts both as "scheduled work allowed" and as idle. */
  isNightShiftActive?: () => boolean;
  isChatActive?: () => boolean;
  /** Null = unknown (headless) — treated as idle rather than blocking. */
  osIdleSeconds?: () => number | null;
  events?: Pick<ChatEventBus, 'publishGlobalEvent'>;
  intervalMs?: number;
  startupDelayMs?: number;
  now?: () => Date;
}

interface ProjectContext {
  project: Project;
  lastActivityAt: string | null;
  voormanName: string | null;
  openTasks: Task[];
  pendingQuestions: number;
  events: HistoryEvent[];
  sessionTitles: string[];
}

export class MeesterStatusGenerator {
  private readonly store: Store;
  private readonly history: HistoryManager;
  private readonly tasks: TaskManager;
  private readonly activity: ActivityTracker;
  private readonly oneShot: StatusOneShot;
  private readonly isNightShiftActive: () => boolean;
  private readonly isChatActive: () => boolean;
  private readonly osIdleSeconds: () => number | null;
  private readonly events?: Pick<ChatEventBus, 'publishGlobalEvent'>;
  private readonly intervalMs: number;
  private readonly startupDelayMs: number;
  private readonly now: () => Date;

  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(opts: MeesterStatusGeneratorOptions) {
    this.store = opts.store;
    this.history = opts.history;
    this.tasks = opts.tasks;
    this.activity = opts.activity;
    this.oneShot = opts.oneShot;
    this.isNightShiftActive = opts.isNightShiftActive ?? (() => false);
    this.isChatActive = opts.isChatActive ?? (() => false);
    this.osIdleSeconds = opts.osIdleSeconds ?? (() => null);
    this.events = opts.events;
    this.intervalMs = opts.intervalMs ?? SWEEP_INTERVAL_MS;
    this.startupDelayMs = opts.startupDelayMs ?? STARTUP_DELAY_MS;
    this.now = opts.now ?? (() => new Date());
  }

  start(): void {
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      void this.sweep().catch((err) => log.warn(`startup sweep failed: ${describe(err)}`));
    }, this.startupDelayMs);
    this.startupTimer.unref?.();
    this.sweepTimer = setInterval(() => {
      void this.sweep().catch((err) => log.warn(`sweep failed: ${describe(err)}`));
    }, this.intervalMs);
    this.sweepTimer.unref?.();
  }

  stop(): void {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.startupTimer = null;
    this.sweepTimer = null;
  }

  isRunning(): boolean {
    return this.running;
  }

  /** One automatic pass through the full gating chain. Exposed for tests. */
  async sweep(): Promise<boolean> {
    if (this.running) return false;
    const config = await this.store.readConfig().catch(() => null);
    const meesterId = config?.meesterGezelId;
    if (!config || config.meesterStatus?.enabled === false || !meesterId) return false;

    const nightShift = this.isNightShiftActive();
    if (!isProactiveAllowed(config) && !(isSchedulingAllowed(config) && nightShift)) return false;

    // Idle gate, mirroring IndexEnrichmentManager.isIdle: an in-flight
    // chat turn always blocks; night shift short-circuits to idle;
    // otherwise require OS idle past the threshold (unknown = idle, so
    // headless daemons still run).
    if (this.isChatActive()) return false;
    if (!nightShift) {
      const idle = this.osIdleSeconds();
      if (idle !== null && idle < OS_IDLE_THRESHOLD_S) return false;
    }

    const now = this.now();
    const state = await this.store.readMeesterStatusState();
    const day = localDay(now);
    const runsToday = state.runDay === day ? (state.runsOnDay ?? 0) : 0;
    const maxRuns = config.meesterStatus?.maxRunsPerDay ?? DEFAULT_MAX_RUNS_PER_DAY;
    if (runsToday >= maxRuns) return false;
    if (state.lastRunAt) {
      const sinceLast = now.getTime() - Date.parse(state.lastRunAt);
      if (Number.isFinite(sinceLast) && sinceLast < MIN_RUN_GAP_MS) return false;
    }

    const candidates = await this.collectCandidates(config);
    const windowMs =
      (config.meesterStatus?.changeWindowHours ?? DEFAULT_CHANGE_WINDOW_HOURS) * 60 * 60_000;
    const lastRunMs = state.lastRunAt ? Date.parse(state.lastRunAt) : 0;
    const changed = candidates.filter((c) => {
      const at = c.lastActivityAt ? Date.parse(c.lastActivityAt) : Number.NaN;
      if (!Number.isFinite(at)) return false;
      return now.getTime() - at <= windowMs && at > lastRunMs;
    });
    if (changed.length === 0) return false;

    const inputHash = hashInput(candidates);
    if (inputHash === state.inputHash) return false;

    return this.generate(config, meesterId, candidates, {
      trigger: 'auto',
      state,
      inputHash,
      countRun: true,
    });
  }

  /**
   * User-requested run. Bypasses the idle, budget, and change gates —
   * only the enabled/meester/engagement floor applies.
   */
  async runNow(): Promise<boolean> {
    if (this.running) return false;
    const config = await this.store.readConfig().catch(() => null);
    const meesterId = config?.meesterGezelId;
    if (!config || config.meesterStatus?.enabled === false || !meesterId) return false;
    if (!isEngagementAllowed(config)) return false;
    const state = await this.store.readMeesterStatusState();
    const candidates = await this.collectCandidates(config);
    return this.generate(config, meesterId, candidates, {
      trigger: 'manual',
      state,
      inputHash: hashInput(candidates),
      countRun: false,
    });
  }

  private async generate(
    config: GezelConfig,
    meesterId: string,
    candidates: ProjectContext[],
    opts: {
      trigger: 'auto' | 'manual';
      state: MeesterStatusState;
      inputHash: string;
      countRun: boolean;
    },
  ): Promise<boolean> {
    this.running = true;
    this.events?.publishGlobalEvent({ type: 'meester_status', state: 'started' });
    try {
      const now = this.now();
      const prompt = buildStatusPrompt(candidates);
      const raw = await this.oneShot(prompt, ONE_SHOT_TIMEOUT_MS, {
        gezelId: meesterId,
        jobLabel: 'meester status report',
      });

      const output = parseModelOutput(raw);
      if (!output) {
        log.warn('model output had no parseable json fence — keeping prior report');
        await this.writeState(opts, now, { preserveInputHash: true });
        this.events?.publishGlobalEvent({ type: 'meester_status', state: 'failed' });
        return false;
      }

      const headline = output.headline.trim().slice(0, MEESTER_STATUS_HEADLINE_MAX);
      const cta = await this.validateCta(output.cta);
      const { actions, actionKeys } = await this.materializeActions(
        output.actions ?? [],
        candidates,
        meesterId,
        opts.state.recentActionKeys ?? [],
      );

      const report: MeesterStatusReport = {
        headline,
        ...(cta ? { cta } : {}),
        report: output.report.trim(),
        generatedAt: now.toISOString(),
        trigger: opts.trigger,
        actions,
      };
      await this.store.writeMeesterStatus(report);
      await this.writeState(opts, now, { actionKeys });
      await this.history.log({
        kind: 'meester.status.generated',
        gezelId: meesterId,
        summary: `Meester status report generated: "${headline}"`,
        details: {
          trigger: opts.trigger,
          projects: candidates.length,
          actions: actions.length,
        },
      });
      this.events?.publishGlobalEvent({
        type: 'meester_status',
        state: 'ended',
        generatedAt: report.generatedAt,
      });
      log.info(`status report generated (${opts.trigger}, ${actions.length} follow-ups)`);
      return true;
    } catch (err) {
      log.warn(`status run failed: ${describe(err)}`);
      await this.writeState(opts, this.now(), { preserveInputHash: true }).catch(() => undefined);
      this.events?.publishGlobalEvent({ type: 'meester_status', state: 'failed' });
      return false;
    } finally {
      this.running = false;
    }
  }

  /**
   * A failed run still consumes budget and advances `lastRunAt` — a
   * chronically-failing model must not retry every sweep. The input
   * hash is only advanced on success, so the next allowed run retries
   * the same input.
   */
  private async writeState(
    opts: { state: MeesterStatusState; inputHash: string; countRun: boolean },
    now: Date,
    extra: { preserveInputHash?: boolean; actionKeys?: string[] } = {},
  ): Promise<void> {
    const day = localDay(now);
    const runsToday = opts.state.runDay === day ? (opts.state.runsOnDay ?? 0) : 0;
    await this.store.writeMeesterStatusState({
      lastRunAt: now.toISOString(),
      inputHash: extra.preserveInputHash ? opts.state.inputHash : opts.inputHash,
      runDay: day,
      runsOnDay: opts.countRun ? runsToday + 1 : runsToday,
      recentActionKeys: extra.actionKeys ?? opts.state.recentActionKeys,
    });
  }

  private async collectCandidates(config: GezelConfig): Promise<ProjectContext[]> {
    const projects = await this.store.listProjects().catch(() => [] as Project[]);
    // The shared library is a reference shelf, not a jobsite: it has no
    // voorman, no progress to chase, and a status report saying so every
    // idle period is pure noise. Deliberate task work filed there still
    // runs — only this ambient check-in skips it.
    const ambient = projects.filter(
      (p) => projectAllowsAmbientWork(p) && !isSharedLibraryProject(p),
    );
    const from = new Date(this.now().getTime() - EVENT_WINDOW_MS).toISOString();
    const out: ProjectContext[] = [];
    for (const project of ambient) {
      const [lastActivityAt, tasks, questions, rawEvents, sessions] = await Promise.all([
        this.activity.lastActivityAt(project.id),
        this.store.listProjectTasks(project.id).catch(() => [] as Task[]),
        this.store.listProjectQuestions(project.id).catch(() => []),
        this.history
          .listEvents({ projectId: project.id, from, limit: MAX_EVENTS_PER_PROJECT * 2 })
          .catch(() => [] as HistoryEvent[]),
        this.store.listSessions({ projectId: project.id }).catch(() => []),
      ]);
      const voorman = project.voormanGezelId
        ? await this.store.getGezel(project.voormanGezelId).catch(() => null)
        : null;
      out.push({
        project,
        lastActivityAt,
        voormanName: voorman?.name ?? null,
        openTasks: tasks
          .filter((t) => t.status === 'active' || t.status === 'paused' || t.status === 'draft')
          .slice(0, MAX_TASKS_PER_PROJECT),
        pendingQuestions: questions.filter((q) => !q.answer).length,
        events: rawEvents
          .filter((e) => e.kind !== 'meester.status.generated')
          .slice(0, MAX_EVENTS_PER_PROJECT),
        sessionTitles: sessions
          .slice()
          .sort((a, b) => (a.lastActivityAt < b.lastActivityAt ? 1 : -1))
          .slice(0, MAX_SESSIONS_PER_PROJECT)
          .map((s) => s.title),
      });
    }
    return out;
  }

  /** Drop CTAs pointing at things that don't exist — a dead click is worse than none. */
  private async validateCta(
    cta: MeesterStatusCta | undefined,
  ): Promise<MeesterStatusCta | undefined> {
    if (!cta) return undefined;
    const target = cta.target;
    if (target.kind === 'view') return cta;
    const project = await this.store.getProject(target.projectId).catch(() => null);
    if (!project) return undefined;
    if (target.kind === 'task') {
      const num = Number.parseInt(target.taskRef.split('/').pop() ?? '', 10);
      if (!Number.isFinite(num)) return undefined;
      const task = await this.store.readTask(target.projectId, num).catch(() => null);
      if (!task) return undefined;
    }
    return cta;
  }

  /**
   * Turn the model's proposed follow-ups into inert draft tasks for the
   * project voorman (meester when none). Deduped two ways: an open task
   * with the same normalized title already in the project, and the
   * recent-action-key ring so a suggestion the user completed or
   * dismissed isn't re-drafted next run.
   */
  private async materializeActions(
    proposed: NonNullable<MeesterStatusModelOutput['actions']>,
    candidates: ProjectContext[],
    meesterId: string,
    recentKeys: string[],
  ): Promise<{ actions: MeesterStatusAction[]; actionKeys: string[] }> {
    const actions: MeesterStatusAction[] = [];
    const keys = [...recentKeys];
    for (const action of proposed.slice(0, MAX_ACTIONS_PER_RUN)) {
      const candidate = candidates.find((c) => c.project.id === action.projectId);
      if (!candidate) continue;
      const key = actionKey(action.projectId, action.title);
      if (keys.includes(key)) continue;
      const existing = await this.store.listProjectTasks(action.projectId).catch(() => []);
      const normalized = normalizeTitle(action.title);
      if (
        existing.some(
          (t) =>
            t.status !== 'complete' &&
            t.status !== 'canceled' &&
            normalizeTitle(t.title) === normalized,
        )
      ) {
        keys.push(key);
        continue;
      }
      try {
        const task = await this.tasks.create(action.projectId, {
          title: action.title,
          description: action.description,
          assignee: {
            kind: 'gezel',
            gezelId: candidate.project.voormanGezelId ?? meesterId,
          },
          status: 'draft',
          steps: [
            {
              id: 'follow-up',
              name: action.title,
              prompt: action.description,
            },
          ],
          entryStepId: 'follow-up',
          createdBy: { kind: 'gezel', gezelId: meesterId },
        });
        actions.push({ projectId: action.projectId, taskRef: task.ref, title: action.title });
        keys.push(key);
      } catch (err) {
        log.warn(`follow-up task in ${action.projectId} failed: ${describe(err)}`);
      }
    }
    return { actions, actionKeys: keys.slice(-MAX_ACTION_KEYS) };
  }
}

/** Local-calendar day, so the daily budget resets at the user's midnight. */
export function localDay(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function actionKey(projectId: string, title: string): string {
  return createHash('sha256')
    .update(`${projectId}\n${normalizeTitle(title)}`)
    .digest('hex');
}

function normalizeTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, ' ');
}

function hashInput(candidates: ProjectContext[]): string {
  const lines = candidates.flatMap((c) => [
    `${c.project.id}:${c.lastActivityAt ?? ''}`,
    ...c.openTasks.map((t) => `${t.ref}:${t.status}`),
    ...c.events.map((e) => e.id),
  ]);
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

function parseModelOutput(raw: string): MeesterStatusModelOutput | null {
  const fence = raw.match(/```(?:json)?\s*\n([\s\S]*?)\n?```/);
  const body = fence?.[1] ?? (raw.trim().startsWith('{') ? raw.trim() : null);
  if (!body) return null;
  try {
    const parsed = MeesterStatusModelOutputSchema.safeParse(JSON.parse(body));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function buildStatusPrompt(candidates: ProjectContext[]): string {
  const sections = candidates.map((c) => {
    const lines: string[] = [`## Project "${c.project.name}" (id: ${c.project.id})`];
    if (c.project.description) lines.push(c.project.description);
    if (c.voormanName) lines.push(`Voorman: ${c.voormanName}`);
    if (c.lastActivityAt) lines.push(`Last activity: ${c.lastActivityAt}`);
    if (c.pendingQuestions > 0) {
      lines.push(`${c.pendingQuestions} question(s) waiting on the user.`);
    }
    if (c.openTasks.length > 0) {
      lines.push('Open tasks:', ...c.openTasks.map((t) => `- [${t.status}] ${t.ref} ${t.title}`));
    }
    if (c.events.length > 0) {
      lines.push('Recent activity:', ...c.events.map((e) => `- ${e.at.slice(0, 16)} ${e.summary}`));
    }
    if (c.sessionTitles.length > 0) {
      lines.push('Recent chats:', ...c.sessionTitles.map((t) => `- ${t}`));
    }
    return lines.join('\n');
  });
  const input = sections.join('\n\n').slice(0, PROMPT_INPUT_CAP);
  const projectIds = candidates.map((c) => `"${c.project.id}"`).join(', ');
  const taskRefs = candidates
    .flatMap((c) => c.openTasks.map((t) => `"${t.ref}"`))
    .slice(0, 40)
    .join(', ');

  return `You are writing the workshop status that greets the user on the Home screen. Below is the current state of every active project.

${input}

Return ONLY one \`\`\`json fence with this exact shape (no prose before or after):

\`\`\`json
{
  "headline": "string, at most ${MEESTER_STATUS_HEADLINE_MAX} characters",
  "cta": { "label": "string, at most 60 characters", "target": { "kind": "project", "projectId": "..." } },
  "report": "markdown string",
  "actions": [ { "projectId": "...", "title": "...", "description": "..." } ]
}
\`\`\`

Rules:
- "headline": warm and concrete, grounded in the projects above, ideally ending in a call to action. Example: "Your space war game is done! Click to play it!" Never generic filler like "Everything is on track."
- "cta" (optional): where clicking the headline lands. "target" is one of {"kind":"project","projectId":...}, {"kind":"task","projectId":...,"taskRef":...}, or {"kind":"view","view":"projects"|"gezels"|"documents"|"settings"}. Valid projectId values: ${projectIds || '(none)'}. Valid taskRef values: ${taskRefs || '(none)'}. Use only these.
- "report": a brief markdown dashboard (at most ~300 words) for the user — per-project status, what moved, what is stuck, what needs them. Ground every statement in the activity above; no speculation.
- "actions" (optional, at most ${MAX_ACTIONS_PER_RUN}): concrete follow-ups worth drafting as tasks for a project's voorman — e.g. reviewing a stalled task, answering an open question, finishing something nearly done. Each needs a projectId from the list above, a short title, and a description telling the voorman exactly what to do and why. Only propose follow-ups that genuinely move a project forward; an empty list is fine.`;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
