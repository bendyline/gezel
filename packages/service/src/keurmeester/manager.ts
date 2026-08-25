import { randomUUID } from 'node:crypto';
import type {
  Craftbook,
  GezelConfig,
  KeurmeesterAction,
  KeurmeesterCaseOutcome,
  KeurmeesterTriggerKind,
  KeurmeesterVerdict,
  ProviderName,
  Task,
  TaskStatus,
} from '@bendyline/gezel';
import {
  KeurmeesterVerdictSchema,
  ProviderNameSchema,
  craftbookFromDoc,
  createLogger,
  docFromCraftbook,
  formatCraftbookDocErrors,
  isLocalProvider,
  parseCraftbookDoc,
  serializeCraftbookDoc,
} from '@bendyline/gezel';
import type { ChatEventBus } from '../chat/events.js';
import { classifyModelTier } from '../chat/local-model-tier.js';
import type { Store } from '../fs/store.js';
import type { HistoryManager } from '../history/manager.js';
import { profileHasBehavior } from '../model-profile/runtime.js';
import type { ResolvedModelProfile } from '../model-profile/types.js';
import { resolveDefaultProviderName } from '../providers/default-provider.js';
import { KeurmeesterCaseStore } from './case-store.js';
import {
  type KeurmeesterConsultBundle,
  buildConsultPrompt,
  buildHandbackNote,
  buildTakeoverPrompt,
} from './prompt.js';

const log = createLogger('keurmeester');

/** Behavior id checked on the struggling session's model profile. */
export const KEURMEESTER_BEHAVIOR_ID = 'supervision.keurmeester';

const DEFAULT_MAX_CONSULTS_PER_SESSION = 2;
const DEFAULT_MAX_CONSULTS_PER_TASK = 3;
const DEFAULT_COOLDOWN_MS = 5 * 60_000;
const CONSULT_TIMEOUT_MS = 120_000;
const TAKEOVER_TURN_TIMEOUT_MS = 10 * 60_000;
/** Takeover caps — hard-coded, deliberately not config-tunable upward. */
const MAX_TAKEOVERS_PER_STEP = 1;
const MAX_TAKEOVERS_PER_TASK = 2;
/** Pending task-outcome watches close as `unknown` after this window. */
const OUTCOME_WINDOW_MS = 30 * 60_000;

/** Actions appliable on a stalled CHAT turn (no task in scope). */
const CHAT_ACTIONS: Array<KeurmeesterAction['kind']> = ['corrective_prompt', 'stand_down'];
/** Actions appliable on a stalled TASK step. Takeover added when eligible. */
const TASK_ACTIONS: Array<KeurmeesterAction['kind']> = [
  'corrective_prompt',
  'rewrite_step',
  'rewrite_craftbook',
  'stand_down',
];
/**
 * A context-pressured session must not receive a corrective prompt —
 * another long prompt into a compaction loop just re-loops. Rewrites
 * reshape the task instead; the re-drive happens later from a fresh
 * context (stuck-step sweep), never into the halted session.
 */
const CONTEXT_LOOP_ACTIONS: Array<KeurmeesterAction['kind']> = [
  'rewrite_step',
  'rewrite_craftbook',
  'stand_down',
];

type OneShotFn = (
  prompt: string,
  timeoutMs: number,
  opts: {
    providerName?: ProviderName;
    model?: string;
    useKeurmeester?: boolean;
    jobLabel?: string;
  },
) => Promise<string>;

/**
 * Narrow ports over TaskManager / ChatManager, injected via setters
 * from service.ts after all three exist — same cycle-avoidance shape
 * as `chat.setScriptRunner`. Structural, so tests can pass stubs.
 */
export interface KeurmeesterTasksPort {
  get(projectId: string, num: number): Promise<Task | null>;
  list(filter?: { projectId?: string; status?: TaskStatus }): Promise<Task[]>;
  replaceCraftbook(projectId: string, num: number, book: Craftbook): Promise<Task>;
  tryIdleAutoAdvance(
    projectId: string,
    num: number,
  ): Promise<'advanced' | 'held' | 'held-frozen' | 'not-ready'>;
}

export interface KeurmeesterChatPort {
  messageGezel(args: {
    fromGezelId: string;
    toGezelIdOrName: string;
    projectId?: string;
    text: string;
    lane?: 'interactive' | 'background';
  }): Promise<{ sessionId: string; toGezelName: string; toGezelId: string }>;
  ensureOrCreateSession(args: { gezelId: string; projectId?: string }): Promise<{ id: string }>;
  send(
    sessionId: string,
    text: string,
    opts?: { lane?: 'interactive' | 'background' },
  ): Promise<unknown>;
}

/**
 * Everything the chat-stall trigger site knows about the struggling
 * session. Assembling this is cheap (string slicing over in-memory
 * messages) relative to the LLM turn that just ran; the expensive part
 * — the consult — only happens after the predicate passes.
 */
export interface ChatStallTriggerCtx {
  trigger: KeurmeesterTriggerKind;
  triggerSummary: string;
  sessionId: string;
  gezelId: string;
  projectId: string;
  providerName: string;
  model?: string;
  modelTier?: string;
  profile?: ResolvedModelProfile;
  transcript: Array<{ role: string; content: string; toolCalls?: string[] }>;
  toolTrace: string[];
  signals: Record<string, unknown>;
}

export interface ChatStallConsultResult {
  caseId: string;
  /** The Keurmeester gezel's display name (for the "stepped in" notice). */
  keurmeesterName: string;
  diagnosis: string;
  /** Present when the verdict was a corrective prompt the caller must apply. */
  correctivePrompt?: string;
}

/** A task step whose recovery machinery has given up. */
export interface TaskStallTriggerCtx {
  trigger: 'step_redrive_exhausted' | 'gate_exhausted' | 'deliverable_plateau';
  triggerSummary: string;
  projectId: string;
  taskNum: number;
  taskRef: string;
  stepId: string;
  assigneeGezelId: string;
  /** Gate trigger: the rejection message + attempt counts, preformatted. */
  gateSummary?: string;
  signals: Record<string, unknown>;
}

/** A chat session halted by the compaction-loop guard. */
export interface ContextLoopTriggerCtx {
  sessionId: string;
  gezelId: string;
  projectId: string;
  providerName: string;
  model?: string;
  modelTier?: string;
  profile?: ResolvedModelProfile;
  compactionsThisSend: number;
}

export interface TaskConsultResult {
  caseId: string;
  keurmeesterName: string;
  diagnosis: string;
  action: KeurmeesterAction['kind'];
  /** True when the action was carried out (message sent / craftbook replaced / step taken over). */
  applied: boolean;
  /** Takeover only: whether the step actually advanced afterwards. */
  takeoverAdvanced?: boolean;
}

/** Flat write-shape shared by every consult path when recording a case. */
interface CaseWriteCtx {
  trigger: KeurmeesterTriggerKind;
  sessionId?: string;
  gezelId: string;
  projectId?: string;
  taskRef?: string;
  stepId?: string;
  providerName: string;
  model?: string;
  modelTier?: string;
  signals: Record<string, unknown>;
}

/**
 * Silent-stall abort classifier: the provider's mid-stream watchdog
 * killed a turn that never produced a single visible character — the
 * known small-model drowning pathology (reasoning burn / prefill
 * overload), NOT a transport fault. Only this class of abort may
 * summon the Keurmeester from the turn-abort path; connection errors,
 * engine crashes, and tool-loop guard aborts never match. Wild-caught
 * (petshop, qwen3.5-9b-q4): `[llama-cpp] no output for 120s
 * mid-stream; aborting (received 0 chars in 543s before going silent
 * for 498s)`.
 */
export function isSilentStallAbort(message: string): boolean {
  return /no output for \d+s mid-stream/.test(message) && /received 0 chars/.test(message);
}

/**
 * Transport-class error shapes that must never summon the Keurmeester
 * from the turn-abort path even when aborts repeat — connection trouble
 * is infrastructure, not a model failing. Deliberately a short, stable
 * list of OS/network error markers rather than a growing heuristic pile.
 */
const TRANSPORT_ERROR_RE =
  /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EPIPE|EAI_AGAIN|fetch failed|socket hang up|network/i;

export function isTransportErrorMessage(message: string): boolean {
  return TRANSPORT_ERROR_RE.test(message);
}

/**
 * Extract and validate a KeurmeesterVerdict from a raw model reply.
 * Accepts a ```json fenced block, a bare JSON object, or JSON embedded
 * in surrounding prose (first `{` to last `}`). Exported for tests.
 */
export function parseVerdict(raw: string): KeurmeesterVerdict {
  const fenced = /```(?:json)?\s*\n?([\s\S]*?)```/.exec(raw);
  const candidates: string[] = [];
  if (fenced?.[1]) candidates.push(fenced[1]);
  candidates.push(raw.trim());
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(raw.slice(first, last + 1));
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return KeurmeesterVerdictSchema.parse(JSON.parse(candidate));
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('no parseable verdict found');
}

/**
 * The Keurmeester supervision engine. Owns the consult predicates, the
 * frontier one-shot, verdict parsing, action application (corrective
 * messages, craftbook rewrites, bounded takeovers), and the append-only
 * case log under `~/.gezel/keurmeester/` (a deliberate Store carve-out —
 * see AGENTS.md). Setter-injected into ChatManager, TaskManager, and
 * TaskScheduler so trigger sites stay one call each; the one-shot and
 * the chat/tasks ports are injected to avoid runtime dependency cycles.
 */
export class KeurmeesterManager {
  private readonly store: Store;
  private readonly history: HistoryManager;
  private readonly events: ChatEventBus;
  private readonly oneShot: OneShotFn;
  readonly cases: KeurmeesterCaseStore;
  private tasksPort?: KeurmeesterTasksPort;
  private chatPort?: KeurmeesterChatPort;

  /** Per-session / per-task consult counters + last-consult timestamps.
   * In-memory — a service restart resetting budgets is acceptable (they
   * guard frontier spend within a stuck stretch, not a durable quota). */
  private readonly sessionConsults = new Map<string, { count: number; lastAt: number }>();
  private readonly taskConsults = new Map<string, { count: number; lastAt: number }>();
  /** `${taskRef}::${stepId}` keys that already received an APPLIED consult —
   * the ladder rung below takeover (the model got its second chance). */
  private readonly appliedStepConsults = new Set<string>();
  private readonly takeoversByStep = new Map<string, number>();
  private readonly takeoversByTask = new Map<string, number>();
  /** Open task cases awaiting an observable outcome, keyed `${taskRef}::${stepId}`. */
  private readonly pendingTaskCases = new Map<string, { caseId: string; timer: NodeJS.Timeout }>();
  /** Open turn-abort cases awaiting a completed turn, keyed by sessionId. */
  private readonly pendingSessionCases = new Map<
    string,
    { caseId: string; timer: NodeJS.Timeout }
  >();
  /** Global concurrency guard: at most one consult in flight, ever. */
  private consultInFlight = false;

  constructor(opts: {
    store: Store;
    history: HistoryManager;
    events: ChatEventBus;
    oneShot: OneShotFn;
    home: string;
  }) {
    this.store = opts.store;
    this.history = opts.history;
    this.events = opts.events;
    this.oneShot = opts.oneShot;
    this.cases = new KeurmeesterCaseStore(opts.home);
  }

  setTasks(port: KeurmeesterTasksPort): void {
    this.tasksPort = port;
  }

  /**
   * One-shot judge consult for `judge` gate checks (D2) — a thin
   * wrapper over the injected frontier one-shot. `{ unavailable }` is
   * the not-armed signal (no config pin / local-only target): the gate
   * evaluator fail-opens on it rather than throwing. Deliberately
   * OUTSIDE the intervention consult budget — a judge is a per-gate
   * quality read, not a recovery escalation; the per-step call cap is
   * enforced by the gate wiring in TaskManager.
   */
  async judgeOneShot(
    prompt: string,
    timeoutMs: number,
  ): Promise<{ text: string } | { unavailable: string }> {
    const config = await this.store.readConfig();
    const target = await this.resolveConsultTarget(config);
    if (!target) {
      return {
        unavailable:
          'keurmeester not armed — set config.keurmeester.providerName/model to a non-local provider',
      };
    }
    const text = await this.oneShot(prompt, timeoutMs, {
      providerName: target.providerName,
      ...(target.model ? { model: target.model } : {}),
      useKeurmeester: true,
      jobLabel: 'judge · gate',
    });
    return { text };
  }

  setChat(port: KeurmeesterChatPort): void {
    this.chatPort = port;
  }

  // ── Chat-stall consults (trigger 1) ─────────────────────────────────

  /**
   * The cheap gate for chat-stall consults. Returns the resolved
   * frontier target when a consult should proceed, false otherwise.
   * Order matters: each check is cheaper or more decisive than the next.
   */
  async shouldConsult(ctx: {
    sessionId: string;
    gezelId: string;
    providerName: string;
    modelTier?: string;
    profile?: ResolvedModelProfile;
  }): Promise<false | { providerName: ProviderName; model?: string }> {
    const config = await this.store.readConfig();
    const enabled =
      config.keurmeester?.enabled === true ||
      profileHasBehavior(ctx.profile, KEURMEESTER_BEHAVIOR_ID);
    if (!enabled) return false;
    // Only small local models are supervised — a frontier model stalling
    // is not a problem another frontier consult fixes, and medium/large
    // local tiers already carry bigger recovery budgets.
    const strugglingProvider = ProviderNameSchema.safeParse(ctx.providerName);
    if (!strugglingProvider.success || !isLocalProvider(strugglingProvider.data)) {
      log.debug(`skip: provider ${ctx.providerName} is not local`);
      return false;
    }
    if (ctx.modelTier !== 'tiny' && ctx.modelTier !== 'small') {
      log.debug(`skip: tier ${ctx.modelTier ?? 'unknown'} not at-risk`);
      return false;
    }
    // Never supervise the supervisor.
    if (config.keurmeesterGezelId && ctx.gezelId === config.keurmeesterGezelId) {
      return false;
    }
    if (this.consultInFlight) {
      log.debug('skip: a consult is already in flight');
      return false;
    }
    if (!this.sessionBudgetAllows(ctx.sessionId, config)) return false;
    const target = await this.resolveConsultTarget(config);
    if (!target) {
      log.info(
        'supervision enabled but no frontier consult target: set config.keurmeester.providerName/model or pin a provider/model on the Keurmeester gezel',
      );
      return false;
    }
    return target;
  }

  private sessionBudgetAllows(sessionId: string, config: GezelConfig): boolean {
    const budget = this.sessionConsults.get(sessionId);
    const maxPerSession =
      config.keurmeester?.maxConsultsPerSession ?? DEFAULT_MAX_CONSULTS_PER_SESSION;
    const cooldownMs = config.keurmeester?.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    if (budget && budget.count >= maxPerSession) {
      log.debug(`skip: session ${sessionId} consult budget spent (${budget.count})`);
      return false;
    }
    if (budget && Date.now() - budget.lastAt < cooldownMs) {
      log.debug(`skip: session ${sessionId} inside cooldown`);
      return false;
    }
    return true;
  }

  private taskBudgetAllows(taskRef: string, config: GezelConfig): boolean {
    const budget = this.taskConsults.get(taskRef);
    const maxPerTask = config.keurmeester?.maxConsultsPerTask ?? DEFAULT_MAX_CONSULTS_PER_TASK;
    const cooldownMs = config.keurmeester?.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    if (budget && budget.count >= maxPerTask) {
      log.debug(`skip: task ${taskRef} consult budget spent (${budget.count})`);
      return false;
    }
    if (budget && Date.now() - budget.lastAt < cooldownMs) {
      log.debug(`skip: task ${taskRef} inside cooldown`);
      return false;
    }
    return true;
  }

  /**
   * Resolve the frontier provider/model the consult runs on: explicit
   * config pin first, then the Keurmeester gezel's own frontmatter.
   * Local providers are refused outright — a consult queued behind the
   * stuck single-slot local engine would deadlock the recovery it's
   * supposed to provide.
   */
  private async resolveConsultTarget(
    config: GezelConfig,
  ): Promise<{ providerName: ProviderName; model?: string } | null> {
    const pinnedRaw = config.keurmeester?.providerName;
    if (pinnedRaw) {
      const pinned = ProviderNameSchema.safeParse(pinnedRaw);
      if (!pinned.success || isLocalProvider(pinned.data)) {
        log.warn(
          `config.keurmeester.providerName=${pinnedRaw} is ${pinned.success ? 'a local provider' : 'not a known provider'} — refusing to consult`,
        );
        return null;
      }
      return {
        providerName: pinned.data,
        ...(config.keurmeester?.model ? { model: config.keurmeester.model } : {}),
      };
    }
    if (config.keurmeesterGezelId) {
      const gezel = await this.store.getGezel(config.keurmeesterGezelId).catch(() => null);
      const provider = ProviderNameSchema.safeParse(gezel?.parsed.frontmatter.provider);
      if (gezel && provider.success && !isLocalProvider(provider.data)) {
        return {
          providerName: provider.data,
          ...(gezel.parsed.frontmatter.model ? { model: gezel.parsed.frontmatter.model } : {}),
        };
      }
    }
    return null;
  }

  /**
   * Full consult for a stalled chat turn (trigger 1). Runs the
   * predicate, mints the Keurmeester gezel if needed, calls the
   * frontier model, parses the verdict (one repair retry), records the
   * case + history + SSE event, and returns the applied action. `null`
   * means "no intervention — existing give-up behavior proceeds", which
   * covers predicate misses, consult failures, and stand_down alike.
   */
  async consultChatStall(ctx: ChatStallTriggerCtx): Promise<ChatStallConsultResult | null> {
    const target = await this.shouldConsult(ctx);
    if (!target) return null;

    this.consultInFlight = true;
    this.bumpBudget(this.sessionConsults, ctx.sessionId);
    try {
      return await this.runChatConsult(ctx, target);
    } finally {
      this.consultInFlight = false;
    }
  }

  private bumpBudget(map: Map<string, { count: number; lastAt: number }>, key: string): void {
    const budget = map.get(key) ?? { count: 0, lastAt: 0 };
    budget.count += 1;
    budget.lastAt = Date.now();
    map.set(key, budget);
  }

  private async runChatConsult(
    ctx: ChatStallTriggerCtx,
    target: { providerName: ProviderName; model?: string },
  ): Promise<ChatStallConsultResult | null> {
    const keurmeester = await this.ensureKeurmeesterGezel(target);
    const struggling = await this.store.getGezel(ctx.gezelId).catch(() => null);
    const bundle: KeurmeesterConsultBundle = {
      trigger: ctx.trigger,
      triggerSummary: ctx.triggerSummary,
      providerName: ctx.providerName,
      ...(ctx.model ? { model: ctx.model } : {}),
      ...(ctx.modelTier ? { modelTier: ctx.modelTier } : {}),
      gezelName: struggling?.name ?? ctx.gezelId,
      ...(struggling?.parsed.frontmatter.role
        ? { gezelRole: struggling.parsed.frontmatter.role }
        : {}),
      transcript: ctx.transcript,
      toolTrace: ctx.toolTrace,
      signals: ctx.signals,
    };
    const prompt = buildConsultPrompt(bundle, CHAT_ACTIONS);
    const caseId = randomUUID();
    const jobLabel = `keurmeester · ${ctx.sessionId.slice(0, 8)}`;
    const caseCtx: CaseWriteCtx = {
      trigger: ctx.trigger,
      sessionId: ctx.sessionId,
      gezelId: ctx.gezelId,
      projectId: ctx.projectId,
      providerName: ctx.providerName,
      ...(ctx.model ? { model: ctx.model } : {}),
      ...(ctx.modelTier ? { modelTier: ctx.modelTier } : {}),
      signals: ctx.signals,
    };

    const consult = await this.runVerdictConsult(prompt, target, jobLabel);
    if (!consult.verdict) {
      await this.recordCase(caseCtx, target, { caseId, ...consult, applied: false });
      return null;
    }
    const verdict = consult.verdict;

    // Downgrade anything the chat path can't apply (the prompt only
    // offers appliable actions, but a model can still improvise).
    let applied = false;
    let correctivePrompt: string | undefined;
    if (verdict.action.kind === 'corrective_prompt') {
      correctivePrompt = verdict.action.prompt;
      applied = true;
    } else if (verdict.action.kind !== 'stand_down') {
      log.warn(
        `verdict action ${verdict.action.kind} not appliable on a chat stall — treating as stand_down`,
      );
    }

    await this.recordCase(caseCtx, target, { caseId, ...consult, verdict, applied });
    await this.logInterventionHistory(caseCtx, keurmeester.name, verdict, applied, caseId);
    if (applied) {
      this.events.publish(
        { sessionId: ctx.sessionId, gezelId: ctx.gezelId, projectId: ctx.projectId },
        {
          type: 'keurmeester_intervention',
          caseId,
          gezelId: keurmeester.id,
          gezelName: keurmeester.name,
          action: verdict.action.kind,
          summary: verdict.diagnosis,
        },
      );
    }
    log.info(
      `consult ${caseId} (session ${ctx.sessionId}): ${verdict.failureClass} → ${verdict.action.kind}${applied ? '' : ' (not applied)'}`,
    );
    return {
      caseId,
      keurmeesterName: keurmeester.name,
      diagnosis: verdict.diagnosis,
      ...(correctivePrompt ? { correctivePrompt } : {}),
    };
  }

  /**
   * Consult for a turn that ABORTED with a silent-stall-class provider
   * error (trigger 5, `turn_aborted`). The aborted turn has already
   * unwound past the continuation loop, so an applied corrective prompt
   * cannot ride `promptForTurn` — it arrives as a fresh recovery turn
   * on the same session via a Keurmeester `messageGezel`. The caller
   * fire-and-forgets this (the consult takes seconds to minutes); the
   * shared per-session budget + cooldown bound abort→consult ping-pong.
   * Outcome: the session's next COMPLETED turn closes the case as
   * unblocked (see noteSessionTurnCompleted); a repeat abort consult
   * closes it re_triggered; the window timer closes it unknown.
   */
  async consultTurnAbort(ctx: ChatStallTriggerCtx): Promise<ChatStallConsultResult | null> {
    const target = await this.shouldConsult(ctx);
    if (!target) return null;
    this.consultInFlight = true;
    this.bumpBudget(this.sessionConsults, ctx.sessionId);
    try {
      const prior = this.pendingSessionCases.get(ctx.sessionId);
      if (prior) {
        clearTimeout(prior.timer);
        this.pendingSessionCases.delete(ctx.sessionId);
        await this.closeCase(prior.caseId, 're_triggered', 0);
      }
      const result = await this.runChatConsult(ctx, target);
      if (result?.correctivePrompt && this.chatPort) {
        const config = await this.store.readConfig();
        const keurmeesterId = config.keurmeesterGezelId;
        if (keurmeesterId && keurmeesterId !== ctx.gezelId) {
          try {
            await this.chatPort.messageGezel({
              fromGezelId: keurmeesterId,
              toGezelIdOrName: ctx.gezelId,
              projectId: ctx.projectId,
              text: result.correctivePrompt,
              lane: 'background',
            });
            const timer = setTimeout(() => {
              this.pendingSessionCases.delete(ctx.sessionId);
              void this.closeCase(result.caseId, 'unknown', 0);
            }, OUTCOME_WINDOW_MS);
            timer.unref?.();
            this.pendingSessionCases.set(ctx.sessionId, { caseId: result.caseId, timer });
          } catch (err) {
            log.warn(
              `turn-abort recovery message failed: ${err instanceof Error ? err.message : err}`,
            );
          }
        }
      }
      return result;
    } finally {
      this.consultInFlight = false;
    }
  }

  /**
   * Called by ChatManager whenever a turn completes on any session —
   * closes an open turn-abort case watching that session as unblocked.
   * Cheap map lookup; no-op for the overwhelming majority of turns.
   */
  noteSessionTurnCompleted(sessionId: string): void {
    const pending = this.pendingSessionCases.get(sessionId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingSessionCases.delete(sessionId);
    void this.closeCase(pending.caseId, 'unblocked', 1);
  }

  // ── Task-stall consults (triggers 2-4) ──────────────────────────────

  /**
   * Consult for a task step whose recovery budget is spent — called by
   * the stuck-step scheduler (before pausing) and by the completion
   * gate (before pausing for help). The verdict can message the
   * assignee, rewrite the step or craftbook, or — when the ladder's
   * lower rungs already ran on this step — take the step over.
   */
  async consultTaskStall(ctx: TaskStallTriggerCtx): Promise<TaskConsultResult | null> {
    const gate = await this.shouldConsultTask(ctx.taskRef, ctx.assigneeGezelId);
    if (!gate) return null;
    this.consultInFlight = true;
    this.bumpBudget(this.taskConsults, ctx.taskRef);
    try {
      return await this.runTaskConsult({
        trigger: ctx.trigger,
        triggerSummary: ctx.triggerSummary,
        projectId: ctx.projectId,
        taskNum: ctx.taskNum,
        taskRef: ctx.taskRef,
        stepId: ctx.stepId,
        assigneeGezelId: ctx.assigneeGezelId,
        ...(ctx.gateSummary ? { gateSummary: ctx.gateSummary } : {}),
        signals: ctx.signals,
        target: gate.target,
        risk: gate.risk,
        allowedBase: TASK_ACTIONS,
        allowTakeover: true,
        sendHandback: true,
      });
    } finally {
      this.consultInFlight = false;
    }
  }

  /**
   * Consult after a compaction-loop halt. Only useful when the halted
   * gezel is driving an active task step in this project — the fix for
   * context pressure is reshaping the task, not more prompt into the
   * halted session, so corrective prompts are not offered and no
   * handback message is sent (the stuck-step sweep re-drives later,
   * from a fresh context).
   */
  async consultContextLoop(ctx: ContextLoopTriggerCtx): Promise<TaskConsultResult | null> {
    const config = await this.store.readConfig();
    const enabled =
      config.keurmeester?.enabled === true ||
      profileHasBehavior(ctx.profile, KEURMEESTER_BEHAVIOR_ID);
    if (!enabled || !this.tasksPort) return null;
    const strugglingProvider = ProviderNameSchema.safeParse(ctx.providerName);
    if (!strugglingProvider.success || !isLocalProvider(strugglingProvider.data)) return null;
    if (ctx.modelTier !== 'tiny' && ctx.modelTier !== 'small') return null;
    if (config.keurmeesterGezelId && ctx.gezelId === config.keurmeesterGezelId) return null;
    if (this.consultInFlight) return null;
    if (!this.sessionBudgetAllows(ctx.sessionId, config)) return null;
    const target = await this.resolveConsultTarget(config);
    if (!target) return null;

    // Find the active task step this gezel is assigned to in the project.
    const active = await this.tasksPort
      .list({ projectId: ctx.projectId, status: 'active' })
      .catch(() => [] as Task[]);
    const task = active.find((t) => {
      if (!t.activeStepId) return false;
      const step = t.craftbook.steps.find((s) => s.id === t.activeStepId);
      if (!step) return false;
      const assignee =
        step.assignee?.kind === 'gezel'
          ? step.assignee.gezelId
          : (step.suggestedGezelId ??
            (t.assignee.kind === 'gezel' ? t.assignee.gezelId : undefined));
      return assignee === ctx.gezelId;
    });
    if (!task?.activeStepId) {
      log.debug(`context_loop consult skipped: no active task step for ${ctx.gezelId}`);
      return null;
    }
    if (!this.taskBudgetAllows(task.ref, config)) return null;

    this.consultInFlight = true;
    this.bumpBudget(this.sessionConsults, ctx.sessionId);
    this.bumpBudget(this.taskConsults, task.ref);
    try {
      return await this.runTaskConsult({
        trigger: 'context_loop',
        triggerSummary: `session halted after ${ctx.compactionsThisSend} compactions in one send (context-pressure loop)`,
        projectId: ctx.projectId,
        taskNum: task.num,
        taskRef: task.ref,
        stepId: task.activeStepId,
        assigneeGezelId: ctx.gezelId,
        sessionId: ctx.sessionId,
        signals: { compactionsThisSend: ctx.compactionsThisSend },
        target,
        risk: {
          providerName: ctx.providerName,
          ...(ctx.model ? { model: ctx.model } : {}),
          ...(ctx.modelTier ? { modelTier: ctx.modelTier } : {}),
        },
        allowedBase: CONTEXT_LOOP_ACTIONS,
        allowTakeover: false,
        sendHandback: false,
      });
    } finally {
      this.consultInFlight = false;
    }
  }

  /** At-risk + budget + target predicate for task-level triggers. */
  private async shouldConsultTask(
    taskRef: string,
    assigneeGezelId: string,
  ): Promise<
    | false
    | {
        target: { providerName: ProviderName; model?: string };
        risk: { providerName: string; model?: string; modelTier?: string };
      }
  > {
    const config = await this.store.readConfig();
    // Task triggers are config-gated only: there is no live model
    // profile in scope here (the assignee isn't mid-turn), and the eval
    // harness sets config.keurmeester alongside the behavior anyway.
    if (config.keurmeester?.enabled !== true) return false;
    if (config.keurmeesterGezelId && assigneeGezelId === config.keurmeesterGezelId) return false;
    if (this.consultInFlight) return false;
    if (!this.taskBudgetAllows(taskRef, config)) return false;
    // At-risk check from the assignee's resolved provider/model — the
    // same tier rule as chat stalls, derived from config + frontmatter
    // because no session state is in scope.
    const gezel = await this.store.getGezel(assigneeGezelId).catch(() => null);
    const providerRaw = gezel?.parsed.frontmatter.provider ?? resolveDefaultProviderName(config);
    const provider = ProviderNameSchema.safeParse(providerRaw);
    if (!provider.success || !isLocalProvider(provider.data)) {
      log.debug(`skip task consult: assignee provider ${String(providerRaw)} is not local`);
      return false;
    }
    const model = gezel?.parsed.frontmatter.model ?? config.defaultModel?.[provider.data];
    const tier = classifyModelTier({ providerName: provider.data, modelId: model });
    if (tier !== 'tiny' && tier !== 'small') {
      log.debug(`skip task consult: assignee tier ${tier} not at-risk`);
      return false;
    }
    const target = await this.resolveConsultTarget(config);
    if (!target) return false;
    return {
      target,
      risk: { providerName: provider.data, ...(model ? { model } : {}), modelTier: tier },
    };
  }

  private async runTaskConsult(args: {
    trigger: KeurmeesterTriggerKind;
    triggerSummary: string;
    projectId: string;
    taskNum: number;
    taskRef: string;
    stepId: string;
    assigneeGezelId: string;
    sessionId?: string;
    gateSummary?: string;
    signals: Record<string, unknown>;
    target: { providerName: ProviderName; model?: string };
    risk: { providerName: string; model?: string; modelTier?: string };
    allowedBase: Array<KeurmeesterAction['kind']>;
    allowTakeover: boolean;
    sendHandback: boolean;
  }): Promise<TaskConsultResult | null> {
    if (!this.tasksPort) return null;
    const config = await this.store.readConfig();
    const task = await this.tasksPort.get(args.projectId, args.taskNum).catch(() => null);
    const step = task?.craftbook.steps.find((s) => s.id === args.stepId);
    if (!task || !step) {
      log.debug(`task consult skipped: ${args.taskRef} step ${args.stepId} moved on`);
      return null;
    }

    // A repeat consult on the same step closes the previous case as
    // re_triggered — its intervention demonstrably didn't stick.
    const stepKey = `${args.taskRef}::${args.stepId}`;
    const pending = this.pendingTaskCases.get(stepKey);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingTaskCases.delete(stepKey);
      await this.closeCase(pending.caseId, 're_triggered', 0);
    }

    const keurmeester = await this.ensureKeurmeesterGezel(args.target);
    const assignee = await this.store.getGezel(args.assigneeGezelId).catch(() => null);

    // Takeover joins the offered actions only once the ladder's lower
    // rungs ran on this step, under the hard caps.
    const takeoverEligible =
      args.allowTakeover &&
      config.keurmeester?.allowTakeover !== false &&
      this.appliedStepConsults.has(stepKey) &&
      (this.takeoversByStep.get(stepKey) ?? 0) < MAX_TAKEOVERS_PER_STEP &&
      (this.takeoversByTask.get(args.taskRef) ?? 0) < MAX_TAKEOVERS_PER_TASK;
    const allowed = takeoverEligible
      ? [...args.allowedBase, 'takeover_step' as const]
      : args.allowedBase;

    let craftbookMarkdown: string | undefined;
    try {
      craftbookMarkdown = serializeCraftbookDoc(
        docFromCraftbook(task.craftbook as unknown as Craftbook),
        'markdown',
      );
    } catch (err) {
      log.warn(
        `could not render craftbook for consult: ${err instanceof Error ? err.message : err}`,
      );
    }

    const bundle: KeurmeesterConsultBundle = {
      trigger: args.trigger,
      triggerSummary: args.triggerSummary,
      providerName: args.risk.providerName,
      ...(args.risk.model ? { model: args.risk.model } : {}),
      ...(args.risk.modelTier ? { modelTier: args.risk.modelTier } : {}),
      gezelName: assignee?.name ?? args.assigneeGezelId,
      ...(assignee?.parsed.frontmatter.role ? { gezelRole: assignee.parsed.frontmatter.role } : {}),
      transcript: await this.recentAssigneeTranscript(args.assigneeGezelId, args.projectId),
      toolTrace: [],
      signals: args.signals,
      task: {
        name: task.title,
        stepId: step.id,
        stepName: step.name,
        stepPrompt: step.prompt,
        ...(args.gateSummary ? { gateSummary: args.gateSummary } : {}),
        ...(craftbookMarkdown ? { craftbookMarkdown } : {}),
      },
    };
    const prompt = buildConsultPrompt(bundle, allowed);
    const caseId = randomUUID();
    const jobLabel = `keurmeester · ${args.taskRef}`;
    const caseCtx: CaseWriteCtx = {
      trigger: args.trigger,
      ...(args.sessionId ? { sessionId: args.sessionId } : {}),
      gezelId: args.assigneeGezelId,
      projectId: args.projectId,
      taskRef: args.taskRef,
      stepId: args.stepId,
      providerName: args.risk.providerName,
      ...(args.risk.model ? { model: args.risk.model } : {}),
      ...(args.risk.modelTier ? { modelTier: args.risk.modelTier } : {}),
      signals: args.signals,
    };

    const consult = await this.runVerdictConsult(prompt, args.target, jobLabel);
    if (!consult.verdict) {
      await this.recordCase(caseCtx, args.target, { caseId, ...consult, applied: false });
      return null;
    }
    const verdict = consult.verdict;

    const application = await this.applyTaskAction({
      verdict,
      allowed,
      task,
      stepId: args.stepId,
      stepName: step.name,
      assigneeGezelId: args.assigneeGezelId,
      keurmeesterId: keurmeester.id,
      projectId: args.projectId,
      taskNum: args.taskNum,
      taskRef: args.taskRef,
      target: args.target,
      sendHandback: args.sendHandback,
    });

    await this.recordCase(caseCtx, args.target, {
      caseId,
      ...consult,
      verdict,
      applied: application.applied,
    });
    await this.logInterventionHistory(
      caseCtx,
      keurmeester.name,
      verdict,
      application.applied,
      caseId,
    );
    if (application.applied && application.sessionId) {
      this.events.publish(
        {
          sessionId: application.sessionId,
          gezelId: args.assigneeGezelId,
          projectId: args.projectId,
        },
        {
          type: 'keurmeester_intervention',
          caseId,
          gezelId: keurmeester.id,
          gezelName: keurmeester.name,
          action: verdict.action.kind,
          summary: verdict.diagnosis,
        },
      );
    }

    // Outcome tracking: takeovers resolve immediately; other applied
    // actions open a watch closed by noteStepAdvanced / re-trigger /
    // the timeout window.
    if (verdict.action.kind === 'takeover_step' && application.applied) {
      await this.closeCase(
        caseId,
        application.takeoverAdvanced ? 'takeover_completed' : 'takeover_failed',
        1,
      );
    } else if (application.applied) {
      this.appliedStepConsults.add(stepKey);
      const timer = setTimeout(() => {
        this.pendingTaskCases.delete(stepKey);
        void this.closeCase(caseId, 'unknown', 0);
      }, OUTCOME_WINDOW_MS);
      timer.unref?.();
      this.pendingTaskCases.set(stepKey, { caseId, timer });
    }

    log.info(
      `consult ${caseId} (${args.taskRef} step ${args.stepId}): ${verdict.failureClass} → ${verdict.action.kind}${application.applied ? '' : ' (not applied)'}`,
    );
    return {
      caseId,
      keurmeesterName: keurmeester.name,
      diagnosis: verdict.diagnosis,
      action: verdict.action.kind,
      applied: application.applied,
      ...(verdict.action.kind === 'takeover_step'
        ? { takeoverAdvanced: application.takeoverAdvanced ?? false }
        : {}),
    };
  }

  private async applyTaskAction(args: {
    verdict: KeurmeesterVerdict;
    allowed: Array<KeurmeesterAction['kind']>;
    task: Task;
    stepId: string;
    stepName: string;
    assigneeGezelId: string;
    keurmeesterId: string;
    projectId: string;
    taskNum: number;
    taskRef: string;
    target: { providerName: ProviderName; model?: string };
    sendHandback: boolean;
  }): Promise<{ applied: boolean; sessionId?: string; takeoverAdvanced?: boolean }> {
    const { verdict } = args;
    if (!args.allowed.includes(verdict.action.kind)) {
      log.warn(
        `verdict action ${verdict.action.kind} not offered for this trigger — treating as stand_down`,
      );
      return { applied: false };
    }
    try {
      switch (verdict.action.kind) {
        case 'stand_down':
          return { applied: false };
        case 'corrective_prompt': {
          if (!this.chatPort) return { applied: false };
          const sent = await this.chatPort.messageGezel({
            fromGezelId: args.keurmeesterId,
            toGezelIdOrName: args.assigneeGezelId,
            projectId: args.projectId,
            text: verdict.action.prompt,
            lane: 'background',
          });
          return { applied: true, sessionId: sent.sessionId };
        }
        case 'rewrite_step': {
          if (!this.tasksPort) return { applied: false };
          const action = verdict.action;
          if (!args.task.craftbook.steps.some((s) => s.id === action.stepId)) {
            log.warn(`rewrite_step names unknown step "${action.stepId}" — standing down`);
            return { applied: false };
          }
          const at = new Date().toISOString();
          const steps = args.task.craftbook.steps.map((s) =>
            s.id === action.stepId
              ? {
                  ...s,
                  prompt: action.prompt,
                  ...(action.name ? { name: action.name } : {}),
                  ...(action.deliverable
                    ? { advanceWhen: { ...(s.advanceWhen ?? {}), file: action.deliverable } }
                    : {}),
                }
              : s,
          );
          const book = {
            ...args.task.craftbook,
            steps,
            updatedAt: at,
          } as unknown as Craftbook;
          await this.tasksPort.replaceCraftbook(args.projectId, args.taskNum, book);
          const sessionId = await this.sendHandbackIfWanted(args, {
            kind: 'rewrite_step',
            detail: verdict.diagnosis,
          });
          return { applied: true, ...(sessionId ? { sessionId } : {}) };
        }
        case 'rewrite_craftbook': {
          if (!this.tasksPort) return { applied: false };
          const built = await this.buildReplacementCraftbook(
            args.task,
            verdict.action.document,
            args.target,
          );
          if (!built) return { applied: false };
          await this.tasksPort.replaceCraftbook(args.projectId, args.taskNum, built);
          const sessionId = await this.sendHandbackIfWanted(args, {
            kind: 'rewrite_craftbook',
            detail: verdict.action.rationale,
          });
          return { applied: true, ...(sessionId ? { sessionId } : {}) };
        }
        case 'takeover_step':
          return await this.performTakeover(args, verdict.action.instruction);
      }
    } catch (err) {
      log.warn(
        `applying ${verdict.action.kind} on ${args.taskRef} failed: ${err instanceof Error ? err.message : err}`,
      );
      return { applied: false };
    }
  }

  /**
   * Parse + validate a replacement craftbook document, with one repair
   * retry that feeds the formatted errors back to the frontier model —
   * the same repair-grade contract as `craftbook_write`.
   */
  private async buildReplacementCraftbook(
    task: Task,
    document: string,
    target: { providerName: ProviderName; model?: string },
  ): Promise<Craftbook | null> {
    const attempt = (doc: string): Craftbook | { errors: string } => {
      const parsed = parseCraftbookDoc(doc);
      if (!parsed.ok) return { errors: formatCraftbookDocErrors(parsed.errors) };
      const built = craftbookFromDoc(parsed.doc, {
        id: task.craftbook.id,
        createdAt: task.craftbook.createdAt,
        now: new Date().toISOString(),
      });
      if (!built.ok) return { errors: formatCraftbookDocErrors(built.errors) };
      return built.craftbook;
    };

    const first = attempt(document);
    if (!('errors' in first)) return first;
    log.info('rewrite_craftbook document invalid — one repair retry with formatted errors');
    const repairPrompt = [
      'The replacement craftbook document you produced was rejected by validation and was NOT saved. Problems:',
      '',
      first.errors,
      '',
      'Reply with ONLY the corrected full craftbook document (markdown form), no fences, no commentary.',
    ].join('\n');
    try {
      const repaired = await this.oneShot(repairPrompt, CONSULT_TIMEOUT_MS, {
        providerName: target.providerName,
        ...(target.model ? { model: target.model } : {}),
        useKeurmeester: true,
        jobLabel: 'keurmeester · craftbook repair',
      });
      const second = attempt(repaired);
      if (!('errors' in second)) return second;
      log.warn(`craftbook repair retry still invalid: ${second.errors.slice(0, 400)}`);
      return null;
    } catch (err) {
      log.warn(`craftbook repair retry failed: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  private async sendHandbackIfWanted(
    args: {
      sendHandback: boolean;
      keurmeesterId: string;
      assigneeGezelId: string;
      projectId: string;
      taskRef: string;
      stepName: string;
    },
    note: { kind: 'rewrite_step' | 'rewrite_craftbook' | 'takeover_step'; detail: string },
  ): Promise<string | undefined> {
    if (!args.sendHandback || !this.chatPort) return undefined;
    try {
      const sent = await this.chatPort.messageGezel({
        fromGezelId: args.keurmeesterId,
        toGezelIdOrName: args.assigneeGezelId,
        projectId: args.projectId,
        text: buildHandbackNote({
          kind: note.kind,
          taskRef: args.taskRef,
          stepName: args.stepName,
          detail: note.detail,
        }),
        lane: 'background',
      });
      return sent.sessionId;
    } catch (err) {
      log.warn(`handback message failed: ${err instanceof Error ? err.message : err}`);
      return undefined;
    }
  }

  /**
   * Bounded takeover: the Keurmeester performs the failing step in its
   * OWN session (its frontmatter pins the frontier provider, so the
   * turn runs on the frontier queue — zero contention with the stuck
   * local slot), then the step gate decides whether the work counts.
   * Success is never declared on the Keurmeester's word alone.
   */
  private async performTakeover(
    args: {
      task: Task;
      stepId: string;
      stepName: string;
      assigneeGezelId: string;
      keurmeesterId: string;
      projectId: string;
      taskNum: number;
      taskRef: string;
      sendHandback: boolean;
    },
    instruction: string,
  ): Promise<{ applied: boolean; sessionId?: string; takeoverAdvanced?: boolean }> {
    if (!this.chatPort || !this.tasksPort) return { applied: false };
    const stepKey = `${args.taskRef}::${args.stepId}`;
    this.takeoversByStep.set(stepKey, (this.takeoversByStep.get(stepKey) ?? 0) + 1);
    this.takeoversByTask.set(args.taskRef, (this.takeoversByTask.get(args.taskRef) ?? 0) + 1);

    // The takeover turn must run on a frontier provider. The lazy mint
    // pins one in frontmatter; a user-designated Keurmeester without a
    // pin would silently run on config.provider (the struggling local
    // engine), so refuse instead.
    const keurmeester = await this.store.getGezel(args.keurmeesterId).catch(() => null);
    const provider = ProviderNameSchema.safeParse(keurmeester?.parsed.frontmatter.provider);
    if (!provider.success || isLocalProvider(provider.data)) {
      log.warn(
        'takeover refused: the Keurmeester gezel has no non-local provider pinned in frontmatter — set one (or use config.keurmeester.providerName at mint time)',
      );
      return { applied: false };
    }

    const step = args.task.craftbook.steps.find((s) => s.id === args.stepId);
    const session = await this.chatPort.ensureOrCreateSession({
      gezelId: args.keurmeesterId,
      projectId: args.projectId,
    });
    log.warn(
      `TAKEOVER: keurmeester performing ${args.taskRef} step "${args.stepId}" (session ${session.id})`,
    );
    await this.chatPort.send(
      session.id,
      buildTakeoverPrompt({
        instruction,
        taskTitle: args.task.title,
        taskRef: args.taskRef,
        stepName: args.stepName,
        stepPrompt: step?.prompt ?? '',
        ...(step?.advanceWhen?.file ? { deliverable: step.advanceWhen.file } : {}),
      }),
      { lane: 'background' },
    );

    // Verify through the task's own machinery — deliverable check +
    // gate — not the Keurmeester's claim of success.
    const adv = await this.tasksPort.tryIdleAutoAdvance(args.projectId, args.taskNum);
    const takeoverAdvanced = adv === 'advanced';
    if (takeoverAdvanced) {
      await this.sendHandbackIfWanted(args, {
        kind: 'takeover_step',
        detail: 'the deliverable is in place and the step has advanced.',
      });
    } else {
      log.warn(
        `takeover of ${args.taskRef} step "${args.stepId}" did not advance the step (${adv}) — existing escalation proceeds`,
      );
    }
    return { applied: true, sessionId: session.id, takeoverAdvanced };
  }

  /**
   * Called by TaskManager whenever a step completes — closes any open
   * intervention case watching that step as `unblocked`.
   */
  noteStepAdvanced(taskRef: string, stepId: string): void {
    const stepKey = `${taskRef}::${stepId}`;
    const pending = this.pendingTaskCases.get(stepKey);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingTaskCases.delete(stepKey);
    void this.closeCase(pending.caseId, 'unblocked', 1);
  }

  // ── Shared consult/record plumbing ──────────────────────────────────

  /** Lazily mint (or fetch) the Keurmeester gezel. Enabled-with-no-pointer
   * means this is the install's first consult — create the inspector now
   * rather than at boot so disabled installs never grow one. The consult
   * target is pinned in frontmatter at mint time so the Keurmeester's own
   * sessions (takeover turns) run on the frontier provider. */
  private async ensureKeurmeesterGezel(target: {
    providerName: ProviderName;
    model?: string;
  }): Promise<{ id: string; name: string }> {
    const config = await this.store.readConfig();
    const existing = config.keurmeesterGezelId
      ? await this.store.getGezel(config.keurmeesterGezelId).catch(() => null)
      : null;
    if (existing) return { id: existing.id, name: existing.name };
    const created = await this.store.createFreshKeurmeester(undefined, {
      provider: target.providerName,
      ...(target.model ? { model: target.model } : {}),
    });
    return { id: created.id, name: created.name };
  }

  /** One consult round-trip: prompt → frontier one-shot → parse, with a
   * single repair retry on parse failure. Never throws. */
  private async runVerdictConsult(
    prompt: string,
    target: { providerName: ProviderName; model?: string },
    jobLabel: string,
  ): Promise<{
    verdict?: KeurmeesterVerdict;
    prompt: string;
    raw: string;
    consultDurationMs: number;
  }> {
    const startedAt = Date.now();
    let raw = '';
    try {
      raw = await this.oneShot(prompt, CONSULT_TIMEOUT_MS, {
        providerName: target.providerName,
        ...(target.model ? { model: target.model } : {}),
        useKeurmeester: true,
        jobLabel,
      });
      try {
        return {
          verdict: parseVerdict(raw),
          prompt,
          raw,
          consultDurationMs: Date.now() - startedAt,
        };
      } catch (parseErr) {
        // One repair retry with the validation error appended — same
        // contract as craftbook_write's repair-grade errors.
        const repairPrompt = `${prompt}\n\nYour previous reply could not be parsed as a valid verdict (${
          parseErr instanceof Error ? parseErr.message : String(parseErr)
        }). Reply again with ONLY the fenced json block, exactly matching the required shape.`;
        raw = await this.oneShot(repairPrompt, CONSULT_TIMEOUT_MS, {
          providerName: target.providerName,
          ...(target.model ? { model: target.model } : {}),
          useKeurmeester: true,
          jobLabel,
        });
        return {
          verdict: parseVerdict(raw),
          prompt,
          raw,
          consultDurationMs: Date.now() - startedAt,
        };
      }
    } catch (err) {
      log.warn(`consult failed (${jobLabel}): ${err instanceof Error ? err.message : err}`);
      return { prompt, raw, consultDurationMs: Date.now() - startedAt };
    }
  }

  private async logInterventionHistory(
    ctx: CaseWriteCtx,
    keurmeesterName: string,
    verdict: KeurmeesterVerdict,
    applied: boolean,
    caseId: string,
  ): Promise<void> {
    await this.history.log({
      kind: 'keurmeester.intervention',
      gezelId: ctx.gezelId,
      ...(ctx.projectId ? { projectId: ctx.projectId } : {}),
      summary: applied
        ? `Keurmeester ${keurmeesterName} stepped in (${verdict.action.kind}): ${verdict.diagnosis}`
        : `Keurmeester ${keurmeesterName} stood down: ${verdict.diagnosis}`,
      details: {
        caseId,
        trigger: ctx.trigger,
        failureClass: verdict.failureClass,
        action: verdict.action.kind,
        confidence: verdict.confidence,
        applied,
        ...(ctx.taskRef ? { taskRef: ctx.taskRef } : {}),
        ...(ctx.stepId ? { stepId: ctx.stepId } : {}),
      },
    });
  }

  /** Best-effort recent transcript from the assignee's latest session in
   * the project — task consults have no live turn state to slice. */
  private async recentAssigneeTranscript(
    gezelId: string,
    projectId: string,
  ): Promise<Array<{ role: string; content: string; toolCalls?: string[] }>> {
    try {
      const sessions = await this.store.listSessions({ gezelId, projectId });
      const latest = sessions
        .filter((s) => !s.archived)
        .sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''))[0];
      if (!latest) return [];
      const session = await this.store.getSession(gezelId, latest.id);
      if (!session) return [];
      return session.messages.slice(-8).map((m) => ({
        role: m.role,
        content: m.content.length > 1200 ? `${m.content.slice(0, 1200)} …[truncated]` : m.content,
        ...(m.toolCalls?.length ? { toolCalls: m.toolCalls.map((t) => t.name) } : {}),
      }));
    } catch {
      return [];
    }
  }

  private async recordCase(
    ctx: CaseWriteCtx,
    target: { providerName: ProviderName; model?: string },
    outcome: {
      caseId: string;
      prompt: string;
      raw: string;
      consultDurationMs: number;
      verdict?: KeurmeesterVerdict;
      applied: boolean;
    },
  ): Promise<void> {
    const config = await this.store.readConfig();
    try {
      await this.cases.append({
        record: 'case.opened',
        caseId: outcome.caseId,
        ts: new Date().toISOString(),
        trigger: ctx.trigger,
        ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
        gezelId: ctx.gezelId,
        ...(ctx.projectId ? { projectId: ctx.projectId } : {}),
        ...(ctx.taskRef ? { taskRef: ctx.taskRef } : {}),
        ...(ctx.stepId ? { stepId: ctx.stepId } : {}),
        providerName: ctx.providerName,
        ...(ctx.model ? { model: ctx.model } : {}),
        ...(ctx.modelTier ? { modelTier: ctx.modelTier } : {}),
        consultProviderName: target.providerName,
        ...(target.model ? { consultModel: target.model } : {}),
        signals: ctx.signals,
        ...(outcome.verdict ? { verdict: outcome.verdict } : {}),
        applied: outcome.applied,
        consultDurationMs: outcome.consultDurationMs,
        promptChars: outcome.prompt.length,
        responseChars: outcome.raw.length,
        ...(config.debugMode === true
          ? { debug: { prompt: outcome.prompt, rawResponse: outcome.raw } }
          : {}),
      });
    } catch (err) {
      // The case log is diagnostics — never let it break the recovery path.
      log.warn(`failed to append case record: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Close a case once its outcome is observable (granted turn ran, etc.). */
  async closeCase(
    caseId: string,
    outcome: KeurmeesterCaseOutcome,
    turnsObserved: number,
  ): Promise<void> {
    try {
      await this.cases.append({
        record: 'case.closed',
        caseId,
        ts: new Date().toISOString(),
        outcome,
        turnsObserved,
      });
    } catch (err) {
      log.warn(`failed to append case close: ${err instanceof Error ? err.message : err}`);
    }
  }
}
