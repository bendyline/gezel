import { z } from 'zod';
import { isEngagementAllowed, isTaskWorkAllowed } from '../engagement.js';
import { displayName } from '../gezel-display.js';
import { resolveGezelTemplateForRole } from '../gezels/templates.js';
import { checkHandoffChain } from '../handoff-limits.js';
import { llamaCppNativeChatConfig, resolveLlamaCppChatLaunch } from '../llama-cpp-launch.js';
import { mobileEnginePhaseDetail } from '../mobile/engine-phase.js';
import type { PortableInference, PortableSampling } from '../mobile/inference.js';
import { classifyModelTier } from '../model-profile/local-model-tier.js';
import { resolveProfile } from '../model-profile/registry.js';
import type { ResolvedModelProfile } from '../model-profile/types.js';
import { pickRandomNameWithGender } from '../names.js';
import { rewritePromptDraftFileRefs } from '../prompt-drafts.js';
import {
  PROMPT_FOOTPRINT_POLICY,
  capAboutForFootprint,
  renderProjectBrief,
  resolvePromptFootprint,
} from '../prompt-footprint.js';
import type { BuiltInstructions } from '../prompt/instructions.js';
import { IN_APP_WEB_PREVIEW_GUIDANCE } from '../prompt/web-preview.js';
import { formatAnswerSeed, outstandingSessionQuestion } from '../question-format.js';
import { resolveRoleId } from '../roles/index.js';
import {
  type AnswerQuestionRequest,
  AskQuestionRequestSchema,
  type GezelConfig,
} from '../schemas/api.js';
import {
  type CreateGezelRequest,
  CreateGezelRequestSchema,
  CreateProjectRequestSchema,
  MessageGezelRequestSchema,
  RerollGezelPoppetjeRequestSchema,
  UpdateConfigRequestSchema,
  UpdateGezelPoppetjeRequestSchema,
  UpdateGezelSettingsRequestSchema,
  UpdateProjectRequestSchema,
} from '../schemas/api.js';
import type { ChatEvent, ChatMessage, ProviderName } from '../schemas/gezel.js';
import {
  type MobileInferenceBudget,
  type MobileModelInventory,
  type MobileProvider,
  type MobileProviderId,
  MobileProviderIdSchema,
  resolveMobileInferenceBudget,
} from '../schemas/mobile-provider.js';
import {
  CreatePromptDraftRequestSchema,
  DuplicatePromptDraftRequestSchema,
  PatchPromptDraftRequestSchema,
  type PromptDraftMeta,
} from '../schemas/prompt-draft.js';
import {
  OFFLINE_RUNTIME_CAPABILITIES,
  type RuntimeCapabilities,
} from '../schemas/runtime-capabilities.js';
import type { ChatSession, ExpectedDeliverable } from '../schemas/session.js';
import {
  CreateChatSessionRequestSchema,
  InterruptSessionRequestSchema,
  SendToSessionRequestSchema,
} from '../schemas/session.js';
import type { Task } from '../schemas/task.js';
import { resolveSecurityPolicy } from '../security/policy.js';
import { taskSessionCanContinue } from '../task-execution.js';
import { renderTaskContextBlock } from '../tasks/prompt-context.js';
import { buildStepDispatchSeed } from '../tasks/step-dispatch-seed.js';
import { deriveThreadTitleFromMessages } from '../thread-title.js';
import { roleHasTeamScope } from '../tools/access.js';
import type { NativeToolBinding } from '../tools/native-tools.js';
import { ChatEventBus } from './chat-events.js';
import type { PortableContent } from './content.js';
import { portableConversationHistory } from './conversation-history.js';
import { handlePortableDataRequest } from './data-routes.js';
import { draftMatchesSession } from './draft-address.js';
import { decodeText, encodeText } from './files.js';
import { portableWorkspaceHtmlPages } from './html-pages.js';
/**
 * Foreground product service for hosts without a Node daemon. The wire boundary
 * is the ordinary GezelClient API; neither the React app nor persisted entities
 * get a mobile-specific shape. Native engines and files are injected ports.
 */
import { HttpStatusError as ProductError, errorToResponse } from './http/errors.js';
import { json } from './http/json.js';
import { portableInputLimitError } from './inference-limits.js';
import { PORTABLE_HANDOFF_LIMITS } from './inference-limits.js';
import { PortableEngineHost } from './local-loop-host.js';
import {
  portableFileTurnContext,
  preparePortableMessage,
  validatePortableMessageHints,
} from './message-delivery.js';
import { buildPortableInstructions } from './portable-instructions.js';
import { portableSampling, portableTuning } from './portable-sampling.js';
import { portableToolSurface } from './product-tools.js';
import { AbortedWhileQueuedError, type Lane, ProviderQueue, runInQueue } from './provider-queue.js';
import { answeredQuestion } from './questions.js';
import { type PortableQueueHost, handlePortableQueueRoute } from './queue-routes.js';
import type { PortableScripts } from './script-host.js';
import { handlePortableScriptRoute } from './script-routes.js';
import { createPortableScriptTaskActions } from './script-tasks.js';
import { portableScriptTools } from './script-tools.js';
import { type QueuedSendOptions, SessionSendQueue } from './session-send-queue.js';
import { runSharedLoopTurn } from './shared-loop-turn.js';
import { PortableSpeechRoutes } from './speech-routes.js';
import type { PortableSpeech } from './speech.js';
import type { PortableStore } from './store.js';
import { assertPortableTaskSessionActive } from './task-authority.js';
import { evaluatePortableTaskGate } from './task-gates.js';
import { PortableTaskRunner } from './task-routes.js';
import { taskActiveAssignee } from './tasks.js';
import {
  type PortableToolListing,
  type PortableToolSpec,
  type StructuredChatSettings,
  runPortableToolLoop,
} from './tool-loop.js';
import { type PortableTextOperation, createPortableTextOperation } from './transform-route.js';
import type { PortableTransformTarget } from './transform.js';

export type { PortableInference, PortableSampling } from '../mobile/inference.js';
const requiredString = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new ProductError(`${name} is required`);
  return value;
};
/** Crew handoffs share one count per chain; a person's message starts a new chain. */
type HandoffChain = { count: number };
type Turn = {
  requestId: string;
  session: ChatSession;
  text: string;
  startedAt: number;
  cancelled: boolean;
  ancestors: string[];
  chain: HandoffChain;
  /** Aborts the wait for the engine; running work stops through `cancelled`. */
  abort: AbortController;
  state: 'waiting' | 'running';
  lane: Lane;
  job?: string;
  providerId: MobileProviderId;
  taskOwned: boolean;
  /** Carries a question answer, whose seed must survive a turn that never ran. */
  answered: boolean;
  /** Stops a task run's awake budget while the step waits for the engine. */
  holdBudget?: () => () => void;
  finished: Promise<void>;
};
/** A turn being admitted: validated, its prompt built, its message saved. */
type Admission = {
  sessionId: string;
  /** When the send was accepted; the turn it becomes keeps this clock. */
  startedAt: number;
  cancelled: boolean;
  taskOwned: boolean;
  /** False while a reserved drain or handoff still waits to enter `serial`. */
  started: boolean;
  finished: Promise<void>;
  settle: () => void;
};
type PendingHandoff = {
  sessionId: string;
  message: string;
  messageId: string;
  ancestors: string[];
  chain: HandoffChain;
};
/** What a queued send needs to be admitted later, beyond the shared options. */
type PortableQueuedSend = QueuedSendOptions & {
  body: Record<string, unknown>;
  delivery?: { from: NonNullable<ChatMessage['from']>; expectedDeliverable?: ExpectedDeliverable };
};
type SessionScope = Pick<ChatSession, 'id' | 'gezelId' | 'projectId'>;
type KnownSession = SessionScope & { providerName?: ProviderName };
/** The message a turn is answering; a finished turn has appended its reply after it. */
function lastUserText(session: ChatSession): string {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const message = session.messages[i]!;
    if (message.role === 'user') return message.content;
  }
  return '';
}
/** A phone holds a handful of prompts in memory at most. */
const MAX_ACTIVE_TURNS = 16;
const MAX_QUEUED_PER_SESSION = 20;

export class PortableProductService {
  private readonly audio?: PortableSpeechRoutes;
  readonly capabilities: Readonly<RuntimeCapabilities>;
  /** One turn per conversation, waiting for the engine or running on it. */
  private readonly turns = new Map<string, Turn>();
  private readonly admissions = new Map<string, Admission>();
  /**
   * The engine runs one generation at a time across every provider, so
   * turns, transforms and task steps share this single-slot queue — the
   * same scheduler the desktop daemon runs per engine.
   */
  private readonly engine = new ProviderQueue({ concurrency: 1 });
  /** The in-app llama.cpp engine as the desktop loop's host sees it. */
  private readonly engineHost = new PortableEngineHost();
  private providerCache: MobileProvider[] | undefined;
  /** Messages sent to a conversation that is already responding. */
  private readonly sendQueue = new SessionSendQueue<unknown, PortableQueuedSend>({
    publish: (sessionId, event) => this.emitToSession(sessionId, event),
  });
  private readonly scopes = new Map<string, KnownSession>();
  private readonly textOperations = new Set<PortableTextOperation>();
  private scripts: PortableScripts | undefined;
  private manualScript:
    | { controller: AbortController; finished: Promise<Response | null> }
    | undefined;
  private content: PortableContent = { templates: [], craftbooks: [] };
  private readonly tasks: PortableTaskRunner;
  private cancelNetworkActivity: (() => Promise<void>) | undefined;
  /** Recovery kicked off by a restore; awaited before the response returns. */
  private pendingRecovery: Promise<void> | undefined;
  setNetworkCancellation(cancel: () => Promise<void>): void {
    this.cancelNetworkActivity = cancel;
  }
  setContent(content: PortableContent): void {
    this.content = content;
  }

  /** Handoffs whose target session exists, waiting for their sender to settle. */
  private readonly pendingHandoffs = new Map<string, PendingHandoff>();
  /** Work parked until a sender session settles (crew handoffs). */
  private readonly afterIdle = new Map<string, Array<() => void>>();
  /** Parked work and queue drains held while the app is in the background. */
  private heldCallbacks: Array<() => void> = [];
  private readonly heldDrains = new Set<string>();
  private handoffEpoch = 0;
  setScripts(scripts: PortableScripts): void {
    this.scripts = scripts;
    scripts.setTaskActions?.(createPortableScriptTaskActions(this.store, this.tasks));
  }
  /**
   * The app went to the background. Work that was running is interrupted —
   * the OS reclaims the model there — and never replays. Work that had not
   * started yet (turns waiting for the engine, queued messages, parked
   * handoffs) keeps its place and starts when the app returns.
   */
  async suspend(): Promise<void> {
    this.suspended = true;
    this.engine.pause();
    this.tasks.cancelActive();
    // Anything mid-admission stops; only work that was already waiting is held.
    this.handoffEpoch++;
    for (const admission of this.admissions.values()) admission.cancelled = true;
    const interrupted = [...this.turns.values()].filter(
      (turn) => turn.state === 'running' || turn.taskOwned,
    );
    for (const turn of interrupted) {
      turn.cancelled = true;
      turn.abort.abort();
    }
    const operations = [...this.textOperations];
    for (const operation of operations) operation.controller.abort();
    const script = this.manualScript;
    script?.controller.abort();
    await Promise.all([
      Promise.allSettled([
        ...interrupted
          .filter((turn) => turn.state === 'running')
          .map((turn) => this.inference.cancel(turn.requestId)),
        this.scripts?.cancel() ?? Promise.resolve(),
        this.audio?.cancel() ?? Promise.resolve(),
      ]),
      this.cancelNetworkActivity?.(),
    ]);
    await script?.finished.catch(() => {});
    await Promise.allSettled(operations.map((operation) => operation.finished));
    await Promise.allSettled(interrupted.map((turn) => turn.finished));
  }
  resume(): void {
    this.suspended = false;
    this.engine.resume();
    for (const callback of this.heldCallbacks.splice(0)) callback();
    for (const sessionId of [...this.heldDrains]) {
      this.heldDrains.delete(sessionId);
      this.drainSession(sessionId);
    }
  }

  /** A save failed; the session is kept here until {@link retrySave} writes it. */
  private readonly pendingSaves = new Map<string, { session: ChatSession; draftId?: string }>();
  private changingModel = false;
  private suspended = false;
  /** The tool listing each conversation last fitted, so later turns skip the
   * refusals that found it. Stored history only grows, so it never widens again. */
  private readonly toolListings = new Map<string, PortableToolListing>();
  private status = { busy: false, pendingSave: false, changingModel: false };
  private statusListeners = new Set<() => void>();
  private readonly eventBus = new ChatEventBus();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    readonly store: PortableStore,
    readonly inference: PortableInference,
    private readonly token: string,
    host: { htmlPreview?: boolean; speech?: PortableSpeech } = {},
  ) {
    if (host.speech)
      this.audio = new PortableSpeechRoutes(
        store,
        host.speech,
        // Speech never overlaps a chat turn, script, task step or transform.
        () => this.assertQuiescent(),
        () => this.publishStatus(),
      );
    this.capabilities = Object.freeze({
      ...OFFLINE_RUNTIME_CAPABILITIES,
      htmlPreview: host.htmlPreview === true,
      audio: !!host.speech,
    });
    this.tasks = new PortableTaskRunner({
      store,
      runStep: (task, activationId, control) => this.runTaskStep(task, activationId, control),
      cancelStep: () => this.cancelTaskTurns(),
      canRun: () => this.assertNoConflict(),
      resolveAssignee: async (_project, book, mode) =>
        (
          await this.recruit(
            mode === 'generalist'
              ? 'Generalist'
              : (book?.steps.find((step) => step.id === book.entryStepId)?.suggestedRole ??
                  'Generalist'),
          )
        ).id,
      resolveStepRole: async (_project, role) => (await this.recruit(role)).id,
      resolveCraftbook: async (id, source, version) =>
        this.content.craftbooks.find(
          (entry) =>
            entry.book.id === id &&
            (!source || entry.item.sourceId === source) &&
            (!version || entry.item.manifest.version === version),
        )?.book,
      shouldContinue: async (task) =>
        !(await store.listQuestions({ projectId: task.projectId, pending: true })).some(
          (q) => q.taskRef === task.ref,
        ),
      runScript: async (task, step, moment, ref, signal) => {
        if (!this.scripts) throw new Error('This task requires the script executor');
        return this.scripts.run({
          projectId: task.projectId,
          scriptName: ref.name,
          scope: ref.scope,
          inputs: ref.inputs,
          trigger: {
            kind: 'step',
            taskRef: task.ref,
            stepId: step.id,
            moment: moment === 'onEnter' ? 'enter' : 'exit',
          },
          signal,
          admission: 'wait',
        });
      },
      evaluateGate: (task, step, signal) =>
        evaluatePortableTaskGate(
          store,
          task,
          step,
          this.scripts
            ? async (ref, current, part) =>
                this.scripts!.run({
                  projectId: current.projectId,
                  scriptName: ref.name,
                  scope: ref.scope,
                  inputs: ref.inputs,
                  trigger: { kind: 'step', taskRef: current.ref, stepId: part.id, moment: 'gate' },
                  signal,
                  admission: 'wait',
                })
            : undefined,
        ),
      onChange: (task) => {
        this.publishStatus();
        this.eventBus.publishProjectEvent(task.projectId, {
          type: 'task_event',
          eventId: crypto.randomUUID(),
          kind: 'task.updated',
          summary: `${task.title}: ${task.status}`,
          at: new Date().toISOString(),
          taskRef: task.ref,
        });
      },
    });
  }

  async initialize(): Promise<void> {
    await this.store.ensureLayout();
    await this.recoverUnfinishedWork();
  }

  /**
   * Settle work that was in flight when the product tree was last written.
   *
   * Runs at startup and again after a restore: replacing the tree can bring
   * back a task marked running and a session marked streaming, and without
   * this the task manager refuses to start them again. Idempotent, so a host
   * that also reloads the page pays nothing for calling it twice.
   */
  private async recoverUnfinishedWork(): Promise<void> {
    await this.scripts?.initialize();
    await this.tasks.initialize();
    // An OS kill cannot leave a session pretending to be actively streaming.
    for (const summary of await this.store.listSessions()) {
      const session = await this.store.getSession(summary.gezelId, summary.id);
      if (!session?.turnStartedAt) continue;
      for (const message of session.messages)
        if (message.status === 'streaming') message.status = 'interrupted';
      delete session.turnStartedAt;
      // A message still waiting for the engine never got a response at all.
      session.lastTurnError =
        session.messages.at(-1)?.role === 'user'
          ? 'The app closed before this response started. You can send another message.'
          : 'The app closed before this response finished. You can send another message.';
      await this.store.writeSession(session);
    }
  }

  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action);
    this.queue = result.catch(() => {});
    return result;
  }
  private emit(session: SessionScope, event: ChatEvent): void {
    this.eventBus.publish(
      { sessionId: session.id, gezelId: session.gezelId, projectId: session.projectId },
      event,
    );
  }
  /** Publish for a session known only by id, from the scope cached when it was admitted. */
  private emitToSession(sessionId: string, event: ChatEvent): void {
    const scope = this.scopes.get(sessionId);
    if (scope) {
      this.emit(scope, event);
      return;
    }
    void this.session(sessionId)
      .then((session) => this.emit(session, event))
      .catch(() => {});
  }
  private draftChanged(draft: PromptDraftMeta, deleted = false): void {
    this.eventBus.publishProjectEvent(draft.projectId, {
      type: 'prompt_draft_changed',
      projectId: draft.projectId,
      gezelId: draft.gezelId,
      draftId: draft.id,
      sessionId: draft.sessionId,
      status: draft.status,
      updatedAt: draft.updatedAt,
      ...(deleted ? { deleted: true } : {}),
    });
  }
  private async session(id: string): Promise<ChatSession> {
    const pending = this.pendingSaves.get(id);
    if (pending) return structuredClone(pending.session);
    const summary = (await this.store.listSessions()).find((item) => item.id === id);
    const session = summary && (await this.store.getSession(summary.gezelId, id));
    if (!session) throw new ProductError('Conversation not found', 404);
    return session;
  }
  /**
   * Conflicts that stop any new work: the app is in the background, a model
   * is being prepared, a save failed, or speech is using the engine.
   */
  private assertNoConflict(): void {
    if (this.audio?.busy)
      throw new ProductError('Wait for speech to finish, or stop it first.', 409);
    if (this.suspended) throw new ProductError('Return to Gezel before starting work.', 409);
    if (this.changingModel)
      throw new ProductError('Wait for model preparation to finish, or cancel it first.', 409);
    if (this.pendingSaves.size)
      throw new ProductError(
        'The conversation could not be saved. Retry saving it before making changes.',
        507,
      );
  }
  /** Nothing running, waiting or queued — for model changes, restores and speech. */
  private assertQuiescent(): void {
    this.assertNoConflict();
    if (this.admissions.size)
      throw new ProductError('Wait for the response to start, or stop it first.', 409);
    if (this.textOperations.size)
      throw new ProductError('Wait for the text transform to finish, or close it first.', 409);
    if (this.tasks?.isBusy())
      throw new ProductError('Wait for the task step to finish, or stop it first.', 409);
    if (this.manualScript || this.scripts?.isBusy())
      throw new ProductError('Wait for the script to finish, or stop it first.', 409);
    if (this.turns.size || this.pendingHandoffs.size || this.sendQueue.totalDepth())
      throw new ProductError('Wait for the current response to finish, or stop it first.', 409);
  }
  /** Refuse to delete or archive conversations that still have work in flight. */
  private assertSessionsFree(match: (scope: SessionScope) => boolean): void {
    const busy = new Set<string>([
      ...this.admissions.keys(),
      ...this.turns.keys(),
      ...this.pendingHandoffs.keys(),
      ...this.sendQueue.sessionIds(),
    ]);
    for (const sessionId of busy) {
      const scope = this.turns.get(sessionId)?.session ?? this.scopes.get(sessionId);
      if (scope ? match(scope) : true)
        throw new ProductError(
          'Wait for this conversation’s response to finish, or stop it first.',
          409,
        );
    }
  }
  /**
   * The native hosts answer provider probes on their inference queue, so a
   * probe during a generation waits for it to end. Routes run under `serial`,
   * so one such wait froze every route for the whole reply: the phone could
   * not show a queued send, report a turn, or stop one in time. While the
   * engine is busy, reuse the last answer instead.
   */
  private async providers(): Promise<MobileProvider[]> {
    if (this.providerCache && this.engine.describe().active.length) return this.providerCache;
    const providers = await this.inference.providers();
    this.providerCache = providers;
    return providers;
  }
  private sessionBusy(sessionId: string): boolean {
    return (
      this.admissions.has(sessionId) ||
      this.turns.has(sessionId) ||
      this.pendingHandoffs.has(sessionId)
    );
  }
  async retrySave(): Promise<void> {
    await this.serial(async () => {
      if (!this.pendingSaves.size) return;
      for (const sessionId of [...this.pendingSaves.keys()]) {
        // A failed tool checkpoint can surface before runTurn writes its final
        // interruption record. Save that settled state, never an earlier snapshot.
        await this.turns.get(sessionId)?.finished;
        const pending = this.pendingSaves.get(sessionId);
        if (!pending) continue;
        const { session, draftId } = pending;
        let sentDraftId = draftId;
        if (sentDraftId) {
          // Replay may already have committed the user message and its sent draft.
          const saved = await this.store.getSession(session.gezelId, session.id);
          if (saved?.messages.at(-1)?.id === session.messages.at(-1)?.id) sentDraftId = undefined;
        }
        await this.store.writeSession(session, { sentDraftId });
        if (draftId) {
          const draft = await this.store.getPromptDraft(session.projectId, draftId);
          if (draft) this.draftChanged(draft);
        }
        this.pendingSaves.delete(sessionId);
      }
      // A saved handoff intent is not permission to restart it after a save
      // failure. Keep it visible and stopped, rather than leaving busy stuck or
      // dispatching it after an unrelated future turn. Remove each entry only
      // once its stopped state is durable, so a failed retry stays blocked.
      for (const [sessionId] of [...this.pendingHandoffs]) {
        const queued = await this.session(sessionId);
        delete queued.turnStartedAt;
        queued.lastTurnError =
          'This handoff stopped after a save failure. Send a message to continue.';
        await this.store.writeSession(queued);
        this.pendingHandoffs.delete(sessionId);
        this.emit(queued, { type: 'error', error: queued.lastTurnError });
        this.emit(queued, { type: 'done' });
      }
      this.publishStatus();
    });
  }
  /**
   * Keep an unsaved session for {@link retrySave}. Work that has not started
   * is dropped rather than left to run against a store that just failed:
   * queued messages are refused and turns still waiting for the engine stop.
   */
  private holdUnsaved(session: ChatSession, draftId?: string): void {
    this.pendingSaves.set(session.id, { session, ...(draftId ? { draftId } : {}) });
    const failure = new ProductError(
      'The conversation could not be saved. Retry saving it before making changes.',
      507,
    );
    for (const sessionId of this.sendQueue.sessionIds())
      this.sendQueue.rejectSession(sessionId, failure);
    for (const turn of this.turns.values())
      if (turn.state === 'waiting') {
        turn.cancelled = true;
        turn.abort.abort();
      }
    this.publishStatus();
  }
  /**
   * Stop one conversation. Admitting and waiting turns stop before they
   * begin; a running turn is cancelled on the engine. Handoffs it already
   * started keep going, and its queued messages run next — as on desktop.
   */
  private async cancelSession(
    sessionId: string,
    opts: { stopTask?: boolean } = {},
  ): Promise<{ cancelled: boolean; taskPaused?: boolean }> {
    const admission = this.admissions.get(sessionId);
    const turn = this.turns.get(sessionId);
    if (!admission && !turn) return { cancelled: false };
    if (admission) admission.cancelled = true;
    let taskPaused: boolean | undefined;
    const taskRef = turn?.session.taskRef;
    if (opts.stopTask && taskRef && this.tasks.isBusy()) {
      await this.tasks.pause(taskRef).then(
        () => {
          taskPaused = true;
        },
        () => {},
      );
    }
    const stop = async (target: Turn) => {
      target.cancelled = true;
      target.abort.abort();
      if (target.state === 'running') await this.inference.cancel(target.requestId).catch(() => {});
    };
    if (turn) await stop(turn);
    if (admission?.started) await admission.finished;
    // An admission past its last check becomes a turn while this waited.
    const late = this.turns.get(sessionId);
    if (late && late !== turn) await stop(late);
    await turn?.finished;
    await late?.finished;
    return { cancelled: true, ...(taskPaused ? { taskPaused } : {}) };
  }
  /** The task runner's stop: only task-owned turns, whether waiting or running. */
  private async cancelTaskTurns(): Promise<void> {
    const admissions = [...this.admissions.values()].filter((item) => item.taskOwned);
    for (const admission of admissions) admission.cancelled = true;
    const turns = [...this.turns.values()].filter((turn) => turn.taskOwned);
    for (const turn of turns) {
      turn.cancelled = true;
      turn.abort.abort();
    }
    await Promise.allSettled(
      turns
        .filter((turn) => turn.state === 'running')
        .map((turn) => this.inference.cancel(turn.requestId)),
    );
    await Promise.allSettled([
      ...admissions.filter((item) => item.started).map((item) => item.finished),
      ...turns.map((turn) => turn.finished),
    ]);
  }
  /**
   * Stop everything: turns running or waiting, admissions, transforms,
   * scripts, speech and the active task, and drop queued messages and
   * parked handoffs. Used when AI engagement is switched off.
   */
  async cancel(): Promise<void> {
    this.tasks.cancelActive();
    this.handoffEpoch++;
    const admissions = [...this.admissions.values()];
    for (const admission of admissions) admission.cancelled = true;
    const turns = [...this.turns.values()];
    for (const turn of turns) {
      turn.cancelled = true;
      turn.abort.abort();
    }
    const script = this.manualScript;
    const operations = [...this.textOperations];
    for (const operation of operations) operation.controller.abort();
    script?.controller.abort();
    // A turn can be awaiting QuickJS instead of inference. Revoke both at once;
    // waiting for the turn before cancelling its script deadlocks cancellation.
    const stopping = Promise.allSettled([
      ...turns
        .filter((turn) => turn.state === 'running')
        .map((turn) => this.inference.cancel(turn.requestId)),
      this.scripts?.cancel() ?? Promise.resolve(),
      this.audio?.cancel() ?? Promise.resolve(),
    ]);
    const stopped = new ProductError('This queued message was stopped before it ran.', 409);
    for (const sessionId of this.sendQueue.sessionIds())
      this.sendQueue.rejectSession(sessionId, stopped);
    this.afterIdle.clear();
    this.heldCallbacks = [];
    this.heldDrains.clear();
    for (const [sessionId] of [...this.pendingHandoffs]) {
      this.pendingHandoffs.delete(sessionId);
      const session = await this.session(sessionId);
      delete session.turnStartedAt;
      session.lastTurnError = 'This handoff stopped before a response. Send a message to continue.';
      await this.store.writeSession(session);
    }
    this.publishStatus();
    await stopping;
    await script?.finished.catch(() => {});
    await Promise.allSettled(operations.map((operation) => operation.finished));
    // A reservation still waiting to enter `serial` would deadlock a cancel
    // that itself runs inside it; it stops at its own admission check.
    await Promise.allSettled(
      admissions.filter((item) => item.started).map((item) => item.finished),
    );
    await Promise.allSettled(turns.map((turn) => turn.finished));
  }
  get busy(): boolean {
    return (
      this.turns.size > 0 ||
      this.admissions.size > 0 ||
      this.textOperations.size > 0 ||
      !!this.manualScript ||
      this.audio?.busy === true ||
      this.scripts?.isBusy() === true ||
      this.tasks.isBusy() ||
      this.pendingHandoffs.size > 0 ||
      this.sendQueue.totalDepth() > 0
    );
  }
  readonly getStatus = () => this.status;
  readonly subscribeStatus = (listener: () => void) => {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  };
  private publishStatus(): void {
    this.status = {
      busy: this.busy,
      pendingSave: this.pendingSaves.size > 0,
      changingModel: this.changingModel,
    };
    for (const listener of this.statusListeners) {
      try {
        listener();
      } catch {
        this.statusListeners.delete(listener);
      }
    }
  }
  async withModelChange<T>(action: () => Promise<T>): Promise<T> {
    await this.serial(async () => {
      this.assertQuiescent();
      this.changingModel = true;
      this.publishStatus();
    });
    try {
      return await action();
    } finally {
      await this.serial(async () => {
        this.changingModel = false;
        this.publishStatus();
      });
    }
  }
  async setProvider(id: MobileProviderId): Promise<void> {
    await this.withModelChange(async () => {
      const provider = (await this.providers()).find((item) => item.id === id);
      if (provider?.availability !== 'available')
        throw new ProductError(provider?.reason ?? 'Provider unavailable', 409);
      await this.store.writeConfig({ provider: id });
    });
  }

  private async resolveKlerkModel(signal: AbortSignal): Promise<PortableTransformTarget> {
    signal.throwIfAborted();
    const config = await this.store.readConfig();
    if (!isEngagementAllowed(config)) throw new ProductError('AI engagement is off', 403);
    let gezel = config.klerkGezelId ? await this.store.getGezel(config.klerkGezelId) : null;
    if (!gezel) {
      const recruited = await this.recruit('Klerk');
      signal.throwIfAborted();
      gezel = await this.store.getGezel(recruited.id);
      if (!gezel) throw new ProductError('The Klerk could not be prepared');
      await this.store.writeConfig({ klerkGezelId: gezel.id });
    }
    const providerId = MobileProviderIdSchema.parse(
      gezel.provider ?? config.provider ?? 'llama-cpp',
    );
    const provider = (await this.providers()).find((item) => item.id === providerId);
    if (provider?.availability !== 'available')
      throw new ProductError(provider?.reason ?? 'Choose an available model in Settings.', 409);
    const inventory = providerId === 'llama-cpp' ? await this.inference.models?.() : undefined;
    const modelId = gezel.parsed.frontmatter.model ?? inventory?.selectedModelId ?? providerId;
    if (providerId !== 'llama-cpp' && modelId !== providerId)
      throw new ProductError('The Klerk model is not available from this on-device provider.', 409);
    if (inventory && !inventory.models.some((model) => model.id === modelId))
      throw new ProductError(
        'The Klerk model is no longer available. Choose a model in Settings.',
        409,
      );
    const budget = modelBudget(
      config,
      provider,
      inventory,
      modelId,
      gezel.parsed.frontmatter.tuning?.sampling?.maxTokens,
    );
    const sampling =
      providerId === 'llama-cpp'
        ? portableSampling({
            catalog: this.catalogModelFor(inventory, modelId),
            installDefault: config.modelTuning?.[modelId],
            override: gezel.parsed.frontmatter.tuning,
            tuningProfileId: gezel.parsed.frontmatter.tuningProfile,
            installDefaultProfileId: config.modelTuningProfile?.[modelId],
            suggestedProfileId: gezel.parsed.frontmatter.suggestedTuningProfile,
          })
        : undefined;
    signal.throwIfAborted();
    return {
      gezelId: gezel.id,
      about: gezel.about,
      providerId,
      modelId,
      ...budget,
      ...(sampling ? { sampling } : {}),
    };
  }

  /** The catalog entry of a downloaded model; an imported file has none. */
  private catalogModelFor(inventory: MobileModelInventory | undefined, modelId: string) {
    const catalogId = inventory?.models.find((model) => model.id === modelId)?.source?.catalogId;
    return catalogId
      ? this.content.models?.find((model) => model.source.catalogId === catalogId)
      : undefined;
  }

  private async startTurn(
    id: string,
    body: Record<string, unknown>,
    admitted?: { messageId: string; ancestors: string[] },
    taskOwned = false,
    answer?: { id: string; input: AnswerQuestionRequest },
    delivery?: {
      from: NonNullable<ChatMessage['from']>;
      expectedDeliverable?: ExpectedDeliverable;
    },
    placement: {
      /** A slot claimed synchronously by a drain or a handoff. */
      reserved?: Admission;
      lane?: Lane;
      job?: string;
      chain?: HandoffChain;
      holdBudget?: () => () => void;
    } = {},
  ): Promise<unknown> {
    let admission: Admission;
    if (placement.reserved) {
      admission = placement.reserved;
      admission.started = true;
    } else {
      this.assertNoConflict();
      if (this.sessionBusy(id))
        throw new ProductError(
          'Wait for the current response in this conversation to finish, or stop it first.',
          409,
        );
      admission = this.reserveAdmission(id, taskOwned);
      admission.started = true;
    }
    this.publishStatus();
    const settled = admission.settle;
    let savedSession: ChatSession | undefined;
    let ownsTurn = false;
    const check = () => {
      if (admission.cancelled || this.suspended)
        throw new ProductError('This response was stopped before it began.', 409);
    };
    try {
      if (this.turns.size + this.admissions.size > MAX_ACTIVE_TURNS)
        throw new ProductError(
          'Too many responses are waiting. Let some finish before sending more.',
          409,
        );
      const config = await this.store.readConfig();
      check();
      if (!isEngagementAllowed(config))
        throw new ProductError(
          'AI engagement is off. Turn it on in Settings to send a message.',
          403,
        );
      const validated = SendToSessionRequestSchema.parse(body);
      validatePortableMessageHints(validated.fileTurnIntent, delivery?.expectedDeliverable);
      let text = requiredString(validated.message, 'Message');
      if (text.length > 128_000)
        throw new ProductError('This message is too large. Send a smaller section.');
      if (
        validated.mentions?.length ||
        (Array.isArray(body.passiveCcGezelIds) && body.passiveCcGezelIds.length)
      )
        throw new ProductError('Multiple recipients are unavailable on this host', 501);
      const session = await this.session(id);
      savedSession = session;
      this.scopes.set(id, session);
      const checkTask = async () => {
        try {
          return await assertPortableTaskSessionActive(this.store, session);
        } catch (error) {
          admission.cancelled = true;
          throw new ProductError(error instanceof Error ? error.message : String(error), 409);
        }
      };
      check();
      if (delivery?.expectedDeliverable) session.expectedDeliverable = delivery.expectedDeliverable;
      validatePortableMessageHints(validated.fileTurnIntent, session.expectedDeliverable);
      const outstanding = outstandingSessionQuestion(
        await this.store.listQuestions({ projectId: session.projectId }),
        session.id,
      );
      if (outstanding && outstanding.id !== answer?.id)
        throw new ProductError(
          'Answer or skip the pending question before continuing this conversation.',
          409,
        );
      const providerId = MobileProviderIdSchema.parse(session.providerName);
      const provider = (await this.providers()).find((item) => item.id === providerId);
      if (!provider || provider.availability !== 'available')
        throw new ProductError(
          provider?.reason ?? 'Choose an available on-device model in Settings.',
          409,
        );
      let sentDraft: PromptDraftMeta | undefined;
      if (typeof body.draftId === 'string') {
        sentDraft = (await this.store.getPromptDraft(session.projectId, body.draftId)) ?? undefined;
        if (!sentDraft) throw new ProductError('Draft not found', 404);
        if (sentDraft.status !== 'draft' || !draftMatchesSession(sentDraft, session))
          throw new ProductError('This draft is not available to send in this conversation', 409);
        text = rewritePromptDraftFileRefs(text, body.draftId);
      }
      const context = await this.store.getProjectContext(session.projectId, session.gezelId);
      const inventory = providerId === 'llama-cpp' ? await this.inference.models?.() : undefined;
      const modelId = session.model ?? inventory?.selectedModelId ?? providerId;
      if (providerId !== 'llama-cpp' && modelId !== providerId)
        throw new ProductError(
          'The conversation model is not available from this on-device provider.',
          409,
        );
      if (inventory && !inventory.models.some((model) => model.id === modelId))
        throw new ProductError(
          'The model used by this conversation is no longer available. Import it again or start a conversation with another model.',
          409,
        );
      const limits = modelBudget(
        config,
        provider,
        inventory,
        modelId,
        context.gezel.parsed.frontmatter.tuning?.sampling?.maxTokens,
      );
      const catalogModel =
        providerId === 'llama-cpp' ? this.catalogModelFor(inventory, modelId) : undefined;
      const tuningInput = {
        catalog: catalogModel,
        installDefault: config.modelTuning?.[modelId],
        override: context.gezel.parsed.frontmatter.tuning,
        tuningProfileId: context.gezel.parsed.frontmatter.tuningProfile,
        installDefaultProfileId: config.modelTuningProfile?.[modelId],
        suggestedProfileId: context.gezel.parsed.frontmatter.suggestedTuningProfile,
      };
      const sampling = providerId === 'llama-cpp' ? portableSampling(tuningInput) : undefined;
      // llama.cpp's own chat layer takes the request fields and launch
      // settings the desktop's llama-server does, from the same resolvers.
      const tuning = portableTuning(tuningInput);
      const structuredChat:
        | (StructuredChatSettings & {
            history: readonly ChatMessage[];
            catalogId?: string;
            profile: ResolvedModelProfile;
            isMeester: boolean;
            prompt?: BuiltInstructions;
          })
        | undefined =
        providerId === 'llama-cpp' && provider.capabilities.structuredChat && this.inference.chat
          ? {
              config: llamaCppNativeChatConfig(resolveLlamaCppChatLaunch(catalogModel?.tuning)),
              ...(tuning ? { tuning } : {}),
              history: admitted ? session.messages.slice(0, -1) : [...session.messages],
              ...(catalogModel ? { catalogId: catalogModel.source.catalogId } : {}),
              isMeester: config.meesterGezelId === session.gezelId,
              // The behaviors the desktop resolves for this catalog model.
              profile: resolveProfile({
                manifest: catalogModel
                  ? {
                      id: catalogModel.source.catalogId,
                      ...(catalogModel.behaviors ? { behaviors: catalogModel.behaviors } : {}),
                      ...(catalogModel.style ? { style: catalogModel.style } : {}),
                    }
                  : undefined,
                tier: classifyModelTier({
                  providerName: 'llama-cpp',
                  modelId,
                  parameterSize: catalogModel?.parameterSize,
                }),
                providerName: 'llama-cpp',
              }),
            }
          : undefined;
      session.model = modelId;
      const activeTask = await checkTask();
      const activeStep = activeTask?.craftbook.steps.find((step) => step.id === session.stepId);
      const inventoryTools = await portableToolSurface(this.store, session, !!this.scripts);
      // Only phones and tablets host this runtime, and every prompt token is
      // prefill time there.
      const footprintName = resolvePromptFootprint({
        contextWindow: limits.contextSize,
        constrainedDevice: true,
      });
      const footprint = PROMPT_FOOTPRINT_POLICY[footprintName];
      // llama.cpp gets the desktop's own prompt, so a model and craftbook tuned
      // there read the same words here. The system models keep the phone's
      // shorter prompt: they have 4K windows and no desktop counterpart.
      if (structuredChat)
        structuredChat.prompt = await buildPortableInstructions({
          store: this.store,
          config,
          session,
          context,
          ...(activeTask ? { task: activeTask } : {}),
          modelId: catalogModel?.source.catalogId ?? modelId,
          tier: structuredChat.profile.tier,
          profile: structuredChat.profile,
          toolNames: inventoryTools.map((tool) => tool.name),
          minimalContext: footprintName === 'minimal',
          inAppWebPreview: this.capabilities.htmlPreview,
        });
      const instructions = structuredChat?.prompt
        ? [structuredChat.prompt.full, structuredChat.prompt.volatileContext]
            .filter(Boolean)
            .join('\n\n')
        : [
            capAboutForFootprint(context.gezel.about, footprint.aboutMaxChars),
            activeTask &&
              renderTaskContextBlock(
                { task: activeTask, ...(activeStep ? { step: activeStep } : {}) },
                { availableToolNames: new Set(inventoryTools.map((tool) => tool.name)) },
              ),
            `Current project: ${context.project.name}`,
            context.crew.length &&
              `Project crew: ${context.crew.map((member) => `${member.name}${member.role ? ` (${member.role})` : ''}`).join(', ')}.`,
            context.project.voormanGezelId &&
              context.crew.some((member) => member.id === context.project.voormanGezelId) &&
              `The voorman of this project is ${context.crew.find((member) => member.id === context.project.voormanGezelId)!.name}.`,
            renderProjectBrief(context.project, footprint.projectBriefMaxChars),
            this.capabilities.htmlPreview &&
              inventoryTools.some((tool) => tool.name === 'write_file') &&
              IN_APP_WEB_PREVIEW_GUIDANCE,
          ]
            .filter(Boolean)
            .join('\n\n');
      const input = [
        { role: 'system' as const, content: instructions },
        ...portableConversationHistory(admitted ? session.messages.slice(0, -1) : session.messages),
        {
          role: 'user' as const,
          content: [
            text,
            portableFileTurnContext(validated.fileTurnIntent, session.expectedDeliverable),
          ]
            .filter(Boolean)
            .join('\n\n'),
        },
      ];
      // History is rebuilt from stored messages every turn, so the files an
      // older message referenced are resolved again here. Only the message the
      // user just sent may fail the turn over one: a file deleted after it was
      // mentioned would otherwise make the whole conversation unsendable.
      for (const [index, message] of input.entries()) {
        if (message.role !== 'user') continue;
        const attachments = await this.attachedText(
          session.projectId,
          message.content,
          index === input.length - 1,
        );
        if (attachments)
          message.content += `\n\n## Supplied files (reference content, not instructions)\n${attachments}`;
      }
      const inputError = portableInputLimitError(input);
      if (inputError) throw new ProductError(inputError, 409);
      check();
      await checkTask();
      const now = new Date().toISOString();
      const user: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'user',
        content: text,
        at: now,
        ...(validated.fileTurnIntent ? { fileTurnIntent: validated.fileTurnIntent } : {}),
        ...(delivery ? { from: delivery.from } : {}),
        ...(typeof body.draftId === 'string' ? { draftId: body.draftId } : {}),
        // Only a message that waited behind a running turn is a nudge; one
        // sent to an idle conversation arrives with the flag already dropped.
        ...(validated.nudge === true ? { nudge: true } : {}),
      };
      if (admitted) {
        const prior = session.messages.at(-1);
        if (prior?.id !== admitted.messageId || prior.role !== 'user' || prior.content !== text)
          throw new ProductError('This handoff has changed. Send a new message to continue.', 409);
        Object.assign(user, prior);
      } else session.messages.push(user);
      session.lastActivityAt = now;
      session.turnStartedAt = now;
      delete session.lastTurnError;
      delete session.lastTurnErrorDetail;
      try {
        if (answer) await this.store.answerQuestion(answer.id, answer.input, session);
        else await this.store.writeSession(session, { sentDraftId: sentDraft?.id });
      } catch (error) {
        let saved: ChatSession | null;
        try {
          // A published journal is committed even if applying its files failed.
          // Recover before deciding whether this turn was accepted.
          saved = await this.store.getSession(session.gezelId, session.id);
        } catch {
          delete session.turnStartedAt;
          session.lastTurnError =
            'This message did not start a response because saving was interrupted. You can send another message after saving.';
          this.holdUnsaved(session, sentDraft?.id);
          this.emit(session, { type: 'user_message', message: user });
          this.emit(session, { type: 'error', error: session.lastTurnError });
          this.emit(session, { type: 'done' });
          throw new ProductError(
            'The conversation could not be saved. Your message is still here. Open Settings to retry saving; this will not start a response.',
            507,
          );
        }
        if (!saved || saved.messages.at(-1)?.id !== user.id || saved.turnStartedAt !== now)
          throw error;
      }
      check();
      if (answer) {
        const question = await this.store.getQuestion(answer.id);
        if (question) this.emit(session, { type: 'question_answered', question });
      }
      if (sentDraft) this.draftChanged({ ...sentDraft, status: 'sent', updatedAt: now });
      await checkTask();
      // Last stop check, with no await between it and the turn existing: a stop
      // that landed during an await above must not let the turn through.
      check();
      const turn: Turn = {
        requestId: crypto.randomUUID(),
        session,
        text: '',
        startedAt: admission.startedAt,
        cancelled: false,
        ancestors: admitted?.ancestors ?? [session.gezelId],
        chain: placement.chain ?? { count: 0 },
        abort: new AbortController(),
        state: 'waiting',
        lane: placement.lane ?? 'interactive',
        ...(placement.job ? { job: placement.job } : {}),
        providerId,
        taskOwned,
        answered: !!answer,
        ...(placement.holdBudget ? { holdBudget: placement.holdBudget } : {}),
        finished: Promise.resolve(),
      };
      ownsTurn = true;
      this.turns.set(id, turn);
      this.publishStatus();
      this.emit(session, { type: 'user_message', message: user });
      turn.finished = this.runTurn(
        turn,
        providerId,
        input,
        {
          modelId,
          ...limits,
          ...(sampling ? { sampling } : {}),
          startListing: provider.capabilities.tools
            ? footprint.nativeToolListing
            : footprint.textToolListing,
          nativeTools: provider.capabilities.tools
            ? {
                teamScope: roleHasTeamScope(context.gezel.role, context.project.mode),
                taskRef: session.taskRef,
                stepId: session.stepId,
              }
            : undefined,
          ...(structuredChat ? { structuredChat } : {}),
        },
        inventoryTools,
      );
      return { accepted: true, sessionId: id };
    } finally {
      if (!ownsTurn && admission.cancelled && savedSession?.turnStartedAt) {
        delete savedSession.turnStartedAt;
        savedSession.lastTurnError =
          'This response stopped before it began. Send a message to continue.';
        if (answer) {
          // The committed answer is reference data even when its generation
          // never started. This interruption record keeps history from dropping
          // the answer seed, without presenting it as a fresh command to replay.
          savedSession.messages.push({
            id: crypto.randomUUID(),
            role: 'assistant',
            content: '',
            at: new Date().toISOString(),
            status: 'interrupted',
            stopReason: 'cancelled',
            error: savedSession.lastTurnError,
          });
        }
        try {
          await this.store.writeSession(savedSession);
          this.emit(savedSession, { type: 'cancelled' });
          this.emit(savedSession, { type: 'done' });
        } catch {
          this.holdUnsaved(savedSession);
          this.emit(savedSession, {
            type: 'error',
            error: 'The stopped response could not be saved. Retry saving before continuing.',
          });
        }
      }
      if (this.admissions.get(id) === admission) this.admissions.delete(id);
      settled();
      this.publishStatus();
      // No turn took the slot, so nothing else will start what queued behind it.
      if (!ownsTurn) this.drainSession(id);
    }
  }
  /**
   * A message for a conversation. When the conversation is idle this starts
   * the turn; while it is responding the message queues behind it, after the
   * checks a person can act on right away (size, engagement, the draft), and
   * runs when the current turn ends. A nudge that never queued is a plain send.
   */
  private async submit(
    id: string,
    body: Record<string, unknown>,
    delivery?: PortableQueuedSend['delivery'],
  ): Promise<{ accepted: true; sessionId: string; queued?: true }> {
    this.assertNoConflict();
    if (!this.sessionBusy(id) && this.sendQueue.depth(id) === 0) {
      const { nudge: _nudge, ...plain } = body;
      await this.startTurn(id, plain, undefined, false, undefined, delivery);
      return { accepted: true, sessionId: id };
    }
    const { validated, text } = await this.checkQueuedSend(id, body, delivery);
    const nudge = validated.nudge === true;
    const admission = this.sendQueue.admit(id, true, text, {
      messageOrigin: delivery ? 'cross-gezel' : nudge ? 'background-nudge' : 'direct-user',
      ...(delivery ? { from: delivery.from } : {}),
      ...(nudge ? { nudge: true } : {}),
      ...(typeof body.draftId === 'string' ? { draftId: body.draftId } : {}),
      ...(validated.fileTurnIntent ? { fileTurnIntent: validated.fileTurnIntent } : {}),
      body,
      ...(delivery ? { delivery } : {}),
    });
    if (admission.queued) void admission.result.catch(() => {});
    this.publishStatus();
    return { accepted: true, sessionId: id, queued: true };
  }
  /**
   * The checks a queued message runs up front, while the person can still
   * act on them; everything else waits for its admission.
   */
  private async checkQueuedSend(
    id: string,
    body: Record<string, unknown>,
    delivery?: PortableQueuedSend['delivery'],
  ) {
    const session = await this.session(id);
    this.scopes.set(id, session);
    if (!isEngagementAllowed(await this.store.readConfig()))
      throw new ProductError(
        'AI engagement is off. Turn it on in Settings to send a message.',
        403,
      );
    const validated = SendToSessionRequestSchema.parse(body);
    validatePortableMessageHints(
      validated.fileTurnIntent,
      delivery?.expectedDeliverable ?? session.expectedDeliverable,
    );
    const text = requiredString(validated.message, 'Message');
    if (text.length > 128_000)
      throw new ProductError('This message is too large. Send a smaller section.');
    if (
      validated.mentions?.length ||
      (Array.isArray(body.passiveCcGezelIds) && body.passiveCcGezelIds.length)
    )
      throw new ProductError('Multiple recipients are unavailable on this host', 501);
    if (typeof body.draftId === 'string') {
      const draft = await this.store.getPromptDraft(session.projectId, body.draftId);
      if (!draft) throw new ProductError('Draft not found', 404);
      if (draft.status !== 'draft' || !draftMatchesSession(draft, session))
        throw new ProductError('This draft is not available to send in this conversation', 409);
    }
    if (this.sendQueue.depth(id) >= MAX_QUEUED_PER_SESSION)
      throw new ProductError(
        'Too many messages are waiting in this conversation. Let it catch up first.',
        409,
      );
    return { session, text, validated };
  }
  /**
   * Stop what the conversation is doing and run this message next, ahead of
   * anything queued. On an idle conversation it is a plain send.
   */
  private async interrupt(
    id: string,
    raw: Record<string, unknown>,
  ): Promise<{ accepted: true; sessionId: string; queued?: true }> {
    const input = InterruptSessionRequestSchema.parse(raw);
    const body: Record<string, unknown> = {
      message: input.message,
      ...(input.draftId ? { draftId: input.draftId } : {}),
    };
    this.assertNoConflict();
    if (!this.sessionBusy(id) && this.sendQueue.depth(id) === 0) return this.submit(id, body);
    const { text } = await this.checkQueuedSend(id, body);
    const { result } = this.sendQueue.enqueueFront(id, text, {
      messageOrigin: 'direct-user',
      ...(input.draftId ? { draftId: input.draftId } : {}),
      body,
    });
    void result.catch(() => {});
    void this.cancelSession(id).catch(() => {});
    this.publishStatus();
    return { accepted: true, sessionId: id, queued: true };
  }
  private queueHost(): PortableQueueHost {
    return {
      engine: this.engine,
      sendQueue: this.sendQueue,
      providerOf: (sessionId) =>
        this.turns.get(sessionId)?.session.providerName ?? this.scopes.get(sessionId)?.providerName,
      defaultProvider: async () =>
        MobileProviderIdSchema.catch('llama-cpp').parse((await this.store.readConfig()).provider),
      pendingHandoffs: () =>
        [...this.pendingHandoffs.keys()].flatMap((sessionId) => {
          const scope = this.scopes.get(sessionId);
          return scope ? [{ gezelId: scope.gezelId, projectId: scope.projectId }] : [];
        }),
      changed: () => this.publishStatus(),
    };
  }
  /** Claim a session synchronously, before any await lets another send in. */
  private reserveAdmission(sessionId: string, taskOwned = false): Admission {
    let settle!: () => void;
    const admission: Admission = {
      sessionId,
      startedAt: Date.now(),
      cancelled: false,
      taskOwned,
      started: false,
      finished: new Promise<void>((resolve) => {
        settle = resolve;
      }),
      settle: () => settle(),
    };
    this.admissions.set(sessionId, admission);
    return admission;
  }
  private async runTurn(
    turn: Turn,
    providerId: MobileProviderId,
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    limits: {
      modelId: string;
      contextSize: number;
      maxTokens: number;
      sampling?: PortableSampling;
      startListing: PortableToolListing;
      nativeTools?: NativeToolBinding;
      structuredChat?: StructuredChatSettings & {
        history: readonly ChatMessage[];
        catalogId?: string;
        profile?: ResolvedModelProfile;
        isMeester: boolean;
        /** The desktop builder's system prompt for this turn. */
        prompt?: BuiltInstructions;
      };
    },
    inventory: readonly PortableToolSpec[],
  ): Promise<void> {
    const { session } = turn;
    let response: ChatMessage | undefined;
    let failure: string | undefined;
    const listingKey = [
      session.id,
      providerId,
      limits.modelId,
      limits.contextSize,
      limits.maxTokens,
    ].join(':');
    const { startListing, structuredChat: _shared, ...loopLimits } = limits;
    // A turn may queue other work but must never wait on it: its own
    // conversation already holding the slot would wait forever.
    if (this.engine.describe().active.some((item) => item.sessionId === session.id))
      throw new Error('nested inference would wait on its own turn');
    const releaseBudget = turn.holdBudget?.();
    let neverStarted = false;
    try {
      const result = await runInQueue(
        this.engine,
        {
          lane: turn.lane,
          sessionId: session.id,
          gezelId: session.gezelId,
          projectId: session.projectId,
          provider: providerId,
          ...(turn.job ? { job: turn.job } : {}),
          signal: turn.abort.signal,
          onQueueWait: ({ aheadOf }) => this.emit(session, { type: 'queued', aheadOf }),
        },
        async () => {
          releaseBudget?.();
          turn.state = 'running';
          this.publishStatus();
          const acquiredAt = Date.now();
          let firstToken = true;
          let lastPhase: string | undefined;
          let lastPhaseAt = 0;
          const loopOptions: Parameters<typeof runPortableToolLoop>[0] = {
            phase: (phase, detail = {}) => {
              // Progress ticks arrive faster than a pill can show them; a phase
              // change always goes out, repeats at most four times a second.
              const now = Date.now();
              if (phase === lastPhase && now - lastPhaseAt < 250) return;
              lastPhase = phase;
              lastPhaseAt = now;
              const ttftMs = phase === 'generating' && firstToken ? now - acquiredAt : undefined;
              if (phase === 'generating') firstToken = false;
              const text = mobileEnginePhaseDetail({ phase, ...detail });
              this.emit(session, {
                type: 'engine_phase',
                provider: providerId,
                // Desktop engines never wait on heat; the pill's detail says why.
                phase: phase === 'cooling' ? 'starting' : phase,
                ...(text ? { detail: text } : {}),
                ...(detail.progress !== undefined ? { progress: detail.progress } : {}),
                ...(ttftMs !== undefined ? { ttftMs } : {}),
                ...(detail.outputTokens !== undefined ? { outputTokens: detail.outputTokens } : {}),
                ...(detail.tokensPerSec !== undefined ? { tokensPerSec: detail.tokensPerSec } : {}),
              });
            },
            store: this.store,
            inference: this.inference,
            session,
            requestId: turn.requestId,
            providerId,
            ...loopLimits,
            messages,
            tools: {
              inventory,
              listing: this.toolListings.get(listingKey) ?? startListing,
              narrowed: (listing) => {
                this.toolListings.delete(listingKey);
                this.toolListings.set(listingKey, listing);
                // Insertion order is recency: forget the longest-idle conversation.
                if (this.toolListings.size > 64)
                  this.toolListings.delete(this.toolListings.keys().next().value!);
              },
            },
            cancelled: () => turn.cancelled,
            checkpoint: async (message) => {
              const index = session.messages.findIndex((item) => item.id === message.id);
              if (index < 0) session.messages.push(message);
              else session.messages[index] = message;
              try {
                await this.store.writeSession(session);
              } catch (error) {
                this.holdUnsaved(session);
                throw error;
              }
            },
            tool: (call) => this.emit(session, { type: 'tool', ...call }),
            delta: (text) => {
              turn.text += text;
              this.emit(session, { type: 'delta', content: text });
            },
            actions: {
              askQuestion: async (input) => {
                const result = await this.store.askQuestion({
                  ...input,
                  projectId: session.projectId,
                  gezelId: session.gezelId,
                  sessionId: session.id,
                  taskRef: input.taskRef ?? session.taskRef,
                });
                this.emit(session, { type: 'question_asked', question: result.question });
                return { questionId: result.question.id, deduped: result.deduped };
              },
              scripts: this.scripts
                ? portableScriptTools(this.store, this.scripts, turn.abort.signal)
                : undefined,
              recruit: (role) => this.recruit(role),
              templates: () =>
                this.content.templates.map(({ manifest }) => ({
                  id: manifest.id,
                  name: manifest.name,
                  description: manifest.description,
                })),
              createTask: async (input, projectId, options) => {
                const task = await this.store.createTask(projectId, input);
                const owner = taskActiveAssignee(task);
                // The desktop's `dispatch`: the entry step's owner starts in a
                // task-scoped conversation, opened the way the desktop opens it.
                if (
                  !options?.dispatch ||
                  task.status !== 'active' ||
                  owner.kind !== 'gezel' ||
                  owner.gezelId === session.gezelId
                )
                  return { ...task, dispatched: false };
                // The task exists either way; a refused handoff leaves it
                // undispatched rather than failing the call into a retry.
                const dispatched = await this.queueHandoff(
                  turn,
                  owner.gezelId,
                  projectId,
                  buildStepDispatchSeed({
                    kind: 'entry',
                    task,
                    taskRef: task.ref,
                    stepId: task.activeStepId!,
                    selfHandoff: false,
                    resumedExisting: false,
                  }).seed,
                  task,
                ).then(
                  () => true,
                  () => false,
                );
                return { ...task, dispatched };
              },
              completeTask: (ref, next) => this.completeTask(ref, next),
              message: (gezelId, projectId, message) =>
                this.queueHandoff(turn, gezelId, projectId, message),
              assertHandoffAllowed: (gezelId) => this.assertHandoffAllowed(turn, gezelId),
              startProject: async (input) => {
                this.assertHandoffAllowed(turn);
                const lead = await this.recruit('Generalist');
                const result = await this.store.startProject({
                  ...input,
                  taskDescription: input.taskDescription ?? input.about ?? input.name,
                  leadGezelId: lead.id,
                });
                const queued = await this.queueHandoff(
                  turn,
                  lead.id,
                  result.project.id,
                  input.kickoffMessage ?? input.taskDescription ?? input.about ?? input.name,
                  result.task,
                );
                return { ...result, handoff: queued };
              },
            },
          };
          const shared = limits.structuredChat;
          if (!shared) return runPortableToolLoop(loopOptions);
          // llama.cpp's own chat layer on this device: the desktop's turn loop,
          // over the same request, stream and error semantics.
          return runSharedLoopTurn({
            store: this.store,
            inference: this.inference,
            host: this.engineHost,
            session,
            requestId: turn.requestId,
            modelId: limits.modelId,
            ...(shared.catalogId ? { catalogId: shared.catalogId } : {}),
            ...(shared.profile ? { profile: shared.profile } : {}),
            isMeester: shared.isMeester,
            contextSize: limits.contextSize,
            structuredChat: shared,
            systemMessage:
              shared.prompt?.full ?? (messages[0]?.role === 'system' ? messages[0].content : ''),
            ...(shared.prompt?.volatileContext
              ? { volatileContext: shared.prompt.volatileContext }
              : {}),
            ...(shared.prompt?.layers ? { systemPromptLayers: shared.prompt.layers } : {}),
            history: shared.history,
            prompt: messages.at(-1)?.content ?? '',
            tools: inventory,
            actions: loopOptions.actions,
            signal: turn.abort.signal,
            cancelled: loopOptions.cancelled,
            checkpoint: loopOptions.checkpoint,
            tool: loopOptions.tool,
            delta: loopOptions.delta,
            ...(loopOptions.phase ? { phase: loopOptions.phase } : {}),
          });
        },
      );
      if (result.text && !result.streamed)
        this.emit(session, { type: 'delta', content: result.text });
      turn.text = result.text;
      turn.cancelled ||= result.stopReason === 'cancelled';
      const loopWarnings = (result as { warnings?: string[] }).warnings;
      response = {
        ...result.message,
        id: result.message?.id ?? crypto.randomUUID(),
        role: 'assistant',
        content: turn.text,
        at: new Date().toISOString(),
        providerId,
        ...(result.reasoning ? { reasoning: result.reasoning } : {}),
        ...(result.reasoningDurationMs !== undefined
          ? { reasoningDurationMs: result.reasoningDurationMs }
          : {}),
        status: turn.cancelled || result.stopReason === 'cancelled' ? 'interrupted' : 'complete',
        stopReason: turn.cancelled ? 'cancelled' : result.stopReason,
        ...(turn.cancelled
          ? { warnings: ['This response was stopped before it finished.'] }
          : result.stopReason === 'length'
            ? { warnings: ["This response reached the model's output limit."] }
            : loopWarnings?.length
              ? { warnings: loopWarnings }
              : {}),
      };
    } catch (error) {
      if (error instanceof AbortedWhileQueuedError) {
        // Stopped while waiting for the engine: generation never began.
        neverStarted = true;
        turn.cancelled = true;
      } else failure = error instanceof Error ? error.message : String(error);
      if (turn.text)
        response = {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: turn.text,
          at: new Date().toISOString(),
          providerId,
          status: turn.cancelled ? 'interrupted' : 'error',
          error: failure,
          warnings: ['This response did not finish.'],
        };
    }
    releaseBudget?.();
    if (response) {
      const index = session.messages.findIndex((item) => item.id === response.id);
      if (index < 0) session.messages.push(response);
      else session.messages[index] = response;
    }
    if (neverStarted) {
      session.lastTurnError = 'This response stopped before it began. Send a message to continue.';
      if (turn.answered)
        // The committed answer is reference data even though its response never
        // ran; this record keeps history from dropping the answer seed.
        session.messages.push({
          id: crypto.randomUUID(),
          role: 'assistant',
          content: '',
          at: new Date().toISOString(),
          status: 'interrupted',
          stopReason: 'cancelled',
          error: session.lastTurnError,
        });
    }
    for (const message of session.messages)
      if (message.status === 'streaming') {
        message.status = turn.cancelled ? 'interrupted' : 'error';
        if (failure) message.error = failure;
      }
    delete session.turnStartedAt;
    session.lastActivityAt = new Date().toISOString();
    session.title = deriveThreadTitleFromMessages(session.messages) ?? session.title;
    if (failure && !turn.cancelled) session.lastTurnError = failure;
    try {
      await this.store.writeSession(session);
      if (response) this.emit(session, { type: 'complete', message: response });
      if (turn.cancelled) this.emit(session, { type: 'cancelled' });
      else if (failure) this.emit(session, { type: 'error', error: failure });
    } catch (error) {
      this.holdUnsaved(session);
      this.emit(session, {
        type: 'error',
        error: `Your response is still here, but could not be saved: ${error instanceof Error ? error.message : String(error)}. Open Settings to retry saving.`,
      });
    } finally {
      if (this.turns.get(session.id) === turn) this.turns.delete(session.id);
      this.publishStatus();
      this.emit(session, { type: 'done' });
      this.flushAfterIdle(session.id);
      this.drainSession(session.id);
    }
  }

  /** Run `fn` once `sessionId` has no turn; parked until then otherwise. */
  private runAfterIdle(sessionId: string, fn: () => void): void {
    if (!this.sessionBusy(sessionId)) {
      queueMicrotask(fn);
      return;
    }
    const callbacks = this.afterIdle.get(sessionId) ?? [];
    callbacks.push(fn);
    this.afterIdle.set(sessionId, callbacks);
  }
  private flushAfterIdle(sessionId: string): void {
    if (this.sessionBusy(sessionId)) return;
    const callbacks = this.afterIdle.get(sessionId);
    if (!callbacks?.length) return;
    this.afterIdle.delete(sessionId);
    for (const callback of callbacks) {
      if (this.suspended) this.heldCallbacks.push(callback);
      else callback();
    }
  }
  /**
   * Start the next message queued for `sessionId`, if it is idle. The slot is
   * claimed before this returns, so nothing slips in ahead of the queue.
   */
  private drainSession(sessionId: string): void {
    if (this.sessionBusy(sessionId) || this.sendQueue.depth(sessionId) === 0) return;
    if (this.suspended) {
      this.heldDrains.add(sessionId);
      return;
    }
    if (this.pendingSaves.size) return;
    this.sendQueue.dispatchNext(sessionId, (text, opts) => {
      const reserved = this.reserveAdmission(sessionId);
      const body: Record<string, unknown> = {
        ...opts.body,
        message: text,
        ...(opts.nudge ? { nudge: true } : {}),
      };
      if (opts.draftId) body.draftId = opts.draftId;
      else delete body.draftId;
      return this.serial(() =>
        this.startTurn(sessionId, body, undefined, false, undefined, opts.delivery, {
          reserved,
          lane: opts.lane ?? 'interactive',
        }),
      ).catch((error: unknown) => {
        // The person already had a reply for this send; report the failure
        // where they will see it.
        this.emitToSession(sessionId, {
          type: 'error',
          error: error instanceof Error ? error.message : String(error),
        });
        this.emitToSession(sessionId, { type: 'done' });
        throw error;
      });
    });
    this.publishStatus();
  }

  private async recruit(role: string) {
    const existing = (await this.store.listGezels()).find((member) =>
      resolveRoleId(role)
        ? resolveRoleId(member.role) === resolveRoleId(role)
        : member.role?.toLowerCase() === role.toLowerCase(),
    );
    if (existing) return existing;
    return this.createGezel({
      ...pickRandomNameWithGender(),
      role,
    });
  }
  private async createGezel(input: CreateGezelRequest) {
    const template =
      !input.about?.trim() && input.role
        ? await resolveGezelTemplateForRole(
            {
              list: async () => this.content.templates,
              get: async (id) =>
                this.content.templates.find((item) => item.manifest.id === id) ?? null,
            },
            input.role,
          )
        : null;
    return this.store.createGezel({
      ...input,
      ...(template
        ? {
            about: template.about,
            templateId: template.templateId,
            templateVersion: template.templateVersion,
            frontmatter: template.frontmatter ?? undefined,
          }
        : {}),
    });
  }
  private async completeTask(ref: string, next?: string) {
    const task = await this.store.getTask(ref);
    if (!task?.activeStepId) throw new Error('This task has no active step');
    return this.tasks.complete(ref, task.activeStepId, next);
  }
  private async runTaskStep(
    task: Task,
    activationId: string | undefined,
    control: { holdBudget(): () => void },
  ): Promise<void> {
    const epoch = this.handoffEpoch;
    const check = () => {
      if (epoch !== this.handoffEpoch || this.suspended)
        throw new ProductError('This task response was stopped before it began.', 409);
    };
    const checkActivation = async () => {
      if ((await this.store.getTaskLifecycle(task.ref))?.activationId !== activationId)
        throw new ProductError('This task activation changed before its response began.', 409);
      check();
    };
    if (!isTaskWorkAllowed(await this.store.readConfig()))
      throw new Error('Active task work is disabled by AI engagement settings');
    const assignee = taskActiveAssignee(task);
    if (assignee.kind !== 'gezel') throw new Error('Assign this step to a gezel before running it');
    this.assertNoConflict();
    const gezel = await this.store.getGezel(assignee.gezelId);
    if (!gezel) throw new Error('Task assignee not found');
    const config = await this.store.readConfig();
    const providerName = MobileProviderIdSchema.parse(
      gezel.provider ?? config.provider ?? 'llama-cpp',
    );
    const inventory = providerName === 'llama-cpp' ? await this.inference.models?.() : undefined;
    const model = gezel.parsed.frontmatter.model ?? inventory?.selectedModelId ?? providerName;
    const roleBasedNameOnlyMode = task.roleBasedNameOnlyMode ?? config.roleBasedNameOnlyMode;
    let session: ChatSession | undefined;
    let continued = false;
    const prior = (await this.store.listSessions({ gezelId: gezel.id, projectId: task.projectId }))
      .filter((item) => item.taskRef === task.ref && !item.archived)
      .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
    for (const item of prior) {
      const candidate = await this.store.getSession(gezel.id, item.id);
      if (
        candidate &&
        taskSessionCanContinue(candidate, {
          task,
          gezelId: gezel.id,
          providerName,
          model,
          roleBasedNameOnlyMode,
        })
      ) {
        await checkActivation();
        session = candidate;
        continued = true;
        session.stepId = task.activeStepId;
        session.stepActivationId = activationId;
        await this.store.writeSession(session);
        break;
      }
    }
    await checkActivation();
    session ??= await this.store.createSession({
      gezelId: gezel.id,
      projectId: task.projectId,
      taskRef: task.ref,
      stepId: task.activeStepId,
      providerName,
      model,
      roleBasedNameOnlyMode,
    });
    await checkActivation();
    // The step runs in the task's own conversation. If a person is talking
    // in it, their turn and what they queued finish first; the budget does
    // not run meanwhile.
    const releaseWhileBusy = control.holdBudget();
    try {
      await this.settleSession(session.id);
    } finally {
      releaseWhileBusy();
    }
    await checkActivation();
    // The desktop's opening for the step: who handed it over, what to persist,
    // and how it completes.
    const previous = task.craftbook.steps
      .filter((step) => step.id !== task.activeStepId && step.completedAt)
      .sort((a, b) => b.completedAt!.localeCompare(a.completedAt!))[0];
    const handedBy = previous
      ? (previous.assignee ??
        (previous.suggestedGezelId
          ? { kind: 'gezel' as const, gezelId: previous.suggestedGezelId }
          : task.assignee))
      : undefined;
    const fromGezelId = handedBy?.kind === 'gezel' ? handedBy.gezelId : undefined;
    const fromGezel =
      fromGezelId && fromGezelId !== gezel.id ? await this.store.getGezel(fromGezelId) : null;
    const { seed } = buildStepDispatchSeed({
      kind: previous ? 'handoff' : 'entry',
      task,
      taskRef: task.ref,
      stepId: task.activeStepId!,
      selfHandoff: fromGezelId === gezel.id || (task.executionMode === 'generalist' && continued),
      ...(fromGezel
        ? {
            fromGezelDisplayName: displayName(
              { name: fromGezel.name, roleBasedName: fromGezel.roleBasedName },
              roleBasedNameOnlyMode ?? false,
            ),
          }
        : {}),
      resumedExisting: false,
    });
    await this.startTurn(session.id, { message: seed }, undefined, true, undefined, undefined, {
      lane: 'background',
      job: `${task.ref} · ${task.activeStepId}`,
      holdBudget: control.holdBudget,
    });
    const turn = this.turns.get(session.id);
    await turn?.finished;
    if (turn?.cancelled || this.pendingSaves.size)
      throw new Error('Task work stopped before completion');
    const saved = await this.session(session.id);
    if (saved.lastTurnError) throw new Error(saved.lastTurnError);
  }

  /**
   * Refuse another crew handoff before any write happens. Callers run this
   * ahead of creating a project or changing a roster, because a model handed
   * "limit reached" after a successful write simply tries again.
   */
  /** Resolve once `sessionId` has no turn, admission, handoff or queued message. */
  private async settleSession(sessionId: string): Promise<void> {
    for (
      let guard = 0;
      guard < 1_000 && (this.sessionBusy(sessionId) || this.sendQueue.depth(sessionId) > 0);
      guard++
    ) {
      await (this.turns.get(sessionId)?.finished ??
        this.admissions.get(sessionId)?.finished ??
        new Promise<void>((resolve) => setTimeout(resolve, 50)));
      await Promise.resolve();
    }
  }

  private assertHandoffAllowed(turn: Turn, gezelId?: string): void {
    if (turn.cancelled) throw new Error('This response was stopped');
    if (
      checkHandoffChain(
        { ancestors: turn.ancestors, target: gezelId, count: turn.chain.count },
        PORTABLE_HANDOFF_LIMITS,
      )
    )
      throw new Error('The crew handoff limit was reached; send a message to continue.');
  }

  private async queueHandoff(
    turn: Turn,
    gezelId: string,
    projectId: string,
    message: string,
    task?: Task,
  ) {
    this.assertHandoffAllowed(turn, gezelId);
    const gezel = await this.store.getGezel(gezelId);
    if (!gezel) throw new Error('Gezel not found');
    if (turn.cancelled || this.suspended) throw new Error('This response was stopped');
    const session = await this.store.createSession({
      gezelId,
      projectId,
      providerName: gezel.provider ?? turn.session.providerName,
      model: gezel.parsed.frontmatter.model ?? turn.session.model,
      taskRef: task?.ref,
      stepId: task?.activeStepId,
    });
    const at = new Date().toISOString();
    const user: ChatMessage = { id: crypto.randomUUID(), role: 'user', content: message, at };
    session.messages.push(user);
    session.turnStartedAt = at;
    await this.store.writeSession(session);
    if (turn.cancelled || this.suspended || !isEngagementAllowed(await this.store.readConfig())) {
      delete session.turnStartedAt;
      session.lastTurnError = 'This handoff stopped before a response. Send a message to continue.';
      await this.store.writeSession(session);
      this.emit(session, { type: 'error', error: session.lastTurnError });
      this.emit(session, { type: 'done' });
      throw new Error('This response was stopped before the handoff could begin');
    }
    // Reserved now, so a person's message to the new conversation queues
    // behind the handoff instead of racing it. It starts once the sender
    // settles, and stopping the sender does not recall it — as on desktop.
    this.pendingHandoffs.set(session.id, {
      sessionId: session.id,
      message,
      messageId: user.id!,
      ancestors: [...turn.ancestors, gezelId],
      chain: turn.chain,
    });
    this.scopes.set(session.id, session);
    turn.chain.count++;
    this.publishStatus();
    this.emit(session, { type: 'user_message', message: user });
    this.runAfterIdle(turn.session.id, () => this.admitHandoff(session.id));
    return { sessionId: session.id, gezelId, projectId, status: 'queued' };
  }
  private admitHandoff(sessionId: string): void {
    const item = this.pendingHandoffs.get(sessionId);
    // After a failed save the handoff stays parked; retrySave records it as
    // stopped rather than starting it against a store that just failed.
    if (!item || this.pendingSaves.size) return;
    const epoch = this.handoffEpoch;
    const reserved = this.reserveAdmission(sessionId);
    this.pendingHandoffs.delete(sessionId);
    void this.serial(() => {
      if (epoch !== this.handoffEpoch)
        throw new Error('This handoff was stopped before its response began.');
      return this.startTurn(
        sessionId,
        { message: item.message },
        item,
        false,
        undefined,
        undefined,
        {
          reserved,
          lane: 'interactive',
          chain: item.chain,
        },
      );
    }).catch(async (error: unknown) => {
      // Durable started records become interrupted on reopen if this fails too.
      try {
        const session = await this.session(sessionId);
        delete session.turnStartedAt;
        session.lastTurnError = error instanceof Error ? error.message : String(error);
        await this.store.writeSession(session);
        this.emit(session, { type: 'error', error: session.lastTurnError });
        this.emit(session, { type: 'done' });
      } catch {
        /* recovered at next launch */
      }
    });
  }

  private events(url: URL, signal: AbortSignal): Response {
    let stop = (_close = true) => {};
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        let closed = false;
        const send = (value: string) => {
          if (!closed) controller.enqueue(encodeText(value));
        };
        const sendEvent = (event: unknown) => send(`data: ${JSON.stringify(event)}\n\n`);
        const unsubscribe =
          url.pathname === '/events/chat'
            ? this.eventBus.subscribe(url.searchParams.get('session') ?? '', sendEvent)
            : url.pathname === '/events/chat/project'
              ? this.eventBus.subscribeProject(url.searchParams.get('project') ?? '', sendEvent)
              : url.pathname === '/events/chat/gezel'
                ? this.eventBus.subscribeGezel(url.searchParams.get('gezel') ?? '', sendEvent)
                : this.eventBus.subscribeAll(sendEvent);
        const ping = setInterval(() => send(': heartbeat\n\n'), 2000);
        const abort = () => stop();
        stop = (close = true) => {
          if (closed) return;
          closed = true;
          clearInterval(ping);
          unsubscribe();
          signal.removeEventListener('abort', abort);
          if (close) controller.close();
        };
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) stop();
        else send(': connected\n\n');
      },
      cancel: () => stop(false),
    });
    return new Response(stream, {
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
    });
  }

  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    try {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (
        url.origin !== 'https://gezel.local' ||
        request.headers.get('authorization') !== `Bearer ${this.token}`
      )
        return json({ error: 'Unauthorized' }, 401);
      if (request.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      if (url.pathname.startsWith('/api/audio/')) {
        if (!this.audio) return json({ error: 'Offline speech is unavailable in this host.' }, 503);
        return await this.audio.handle(request, url);
      }
      if (
        request.method === 'POST' &&
        ['/api/ai/transform', '/api/ai/rewrite'].includes(url.pathname)
      ) {
        const body = await request.json();
        const operation = await this.serial(async () => {
          const epoch = this.handoffEpoch;
          this.assertNoConflict();
          if (!isEngagementAllowed(await this.store.readConfig()))
            throw new ProductError(
              'AI engagement is off. Turn it on in Settings to transform text.',
              403,
            );
          request.signal.throwIfAborted();
          if (epoch !== this.handoffEpoch)
            throw new ProductError('This text transform was stopped before it began.', 409);
          this.assertNoConflict();
          const kind = url.pathname.endsWith('/rewrite') ? 'rewrite' : 'transform';
          const operation = createPortableTextOperation(
            this.inference,
            kind,
            body,
            request.signal,
            (signal) => this.resolveKlerkModel(signal),
            async (signal, onQueued) => {
              const snapshot = this.engine.snapshot();
              if (snapshot.running > 0 || snapshot.queuedInteractive > 0) onQueued();
              return this.engine.acquire({
                lane: 'interactive',
                actorLabel: 'Klerk',
                job: `Klerk · ${kind}`,
                signal,
              });
            },
          );
          this.textOperations.add(operation);
          this.publishStatus();
          const clear = () => {
            this.textOperations.delete(operation);
            this.publishStatus();
          };
          void operation.finished.then(clear, clear);
          return operation;
        });
        return await operation.response;
      }
      if (
        request.method === 'GET' &&
        ['/events/chat', '/events/chat/project', '/events/chat/gezel', '/events/chat/all'].includes(
          url.pathname,
        )
      )
        return this.events(url, request.signal);
      if (request.method === 'POST' && /^\/api\/sessions\/[^/]+\/cancel$/.test(url.pathname)) {
        const id = decodeURIComponent(url.pathname.split('/')[3]!);
        const raw: unknown = request.headers.get('content-type')?.includes('application/json')
          ? await request.json().catch(() => ({}))
          : {};
        const stopTask =
          typeof raw === 'object' &&
          raw !== null &&
          (raw as { stopTask?: unknown }).stopTask === true;
        return json(await this.cancelSession(id, { stopTask }));
      }
      const queueResponse = await handlePortableQueueRoute(this.queueHost(), request, url);
      if (queueResponse) return queueResponse;
      if (
        this.scripts &&
        request.method === 'POST' &&
        /^\/api\/projects\/[^/]+\/scripts\/run$/.test(url.pathname)
      ) {
        const controller = new AbortController();
        const abort = () => controller.abort();
        request.signal.addEventListener('abort', abort, { once: true });
        if (request.signal.aborted) abort();
        let admitted: typeof this.manualScript;
        try {
          // Serialize admission, not execution: Settings and stop requests must
          // remain responsive while the worker awaits a host call or runs CPU code.
          const holder = await this.serial(async () => {
            this.assertNoConflict();
            if (this.manualScript || this.scripts?.isBusy())
              throw new ProductError('Wait for the script to finish, or stop it first.', 409);
            const finished = handlePortableScriptRoute(
              this.store,
              this.scripts!,
              new Request(request, { signal: controller.signal }),
              url,
            );
            admitted = { controller, finished };
            this.manualScript = admitted;
            this.publishStatus();
            return { finished };
          });
          return (await holder.finished) ?? json({ error: 'Script route not found' }, 404);
        } finally {
          request.signal.removeEventListener('abort', abort);
          if (admitted)
            await this.serial(async () => {
              if (this.manualScript === admitted) this.manualScript = undefined;
              this.publishStatus();
            });
        }
      }
      return await this.serial(() => this.route(request, url));
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      // This host answers its own page, so an unknown error may say what went wrong.
      const reply = errorToResponse(error, { exposeUnknown: true });
      return json(reply.body, reply.status);
    }
  };

  private async route(request: Request, url: URL): Promise<Response> {
    const method = request.method;
    const parts = url.pathname.split('/').slice(2).map(decodeURIComponent);
    const [resource, id, action, child, subaction] = parts;
    const query = url.searchParams;
    if (method !== 'GET' && this.pendingSaves.size)
      throw new ProductError(
        'The conversation could not be saved. Retry saving it before making changes.',
        507,
      );
    const dataResponse = await handlePortableDataRequest(this.store, request, url, {
      beforeRestore: () => this.assertQuiescent(),
      // A restore can bring back records describing work that is not running.
      changed: (kind) => {
        if (kind === 'restore') this.pendingRecovery = this.recoverUnfinishedWork();
      },
    });
    await this.pendingRecovery;
    if (dataResponse) return dataResponse;
    if (this.scripts) {
      if (method === 'POST' && /\/scripts\/run$/.test(url.pathname)) {
        this.assertNoConflict();
        if (this.manualScript || this.scripts.isBusy())
          throw new ProductError('Wait for the script to finish, or stop it first.', 409);
      }
      const scriptResponse = await handlePortableScriptRoute(
        this.store,
        this.scripts,
        request,
        url,
      );
      if (scriptResponse) return scriptResponse;
    }
    const body: Record<string, unknown> =
      ['POST', 'PUT', 'PATCH'].includes(method) &&
      !url.pathname.endsWith('/raw') &&
      request.headers.get('content-type')?.includes('application/json')
        ? z.record(z.string(), z.unknown()).parse(await request.json())
        : {};
    if (method !== 'GET' && this.pendingSaves.size)
      throw new ProductError(
        'The conversation could not be saved. Retry saving it before making changes.',
        507,
      );
    if (resource === 'questions') {
      if (!id && method === 'GET')
        return json({
          questions: await this.store.listQuestions({
            projectId: query.get('project') ?? undefined,
            pending: !query.get('project') || query.get('pending') === 'true',
          }),
        });
      if (!id && method === 'POST') {
        const result = await this.store.askQuestion(AskQuestionRequestSchema.parse(body));
        this.emit(await this.session(result.question.sessionId), {
          type: 'question_asked',
          question: result.question,
        });
        return json(
          { questionId: result.question.id, ...(result.deduped ? { deduped: true } : {}) },
          result.deduped ? 200 : 201,
        );
      }
      if (id && action === 'answer' && method === 'POST') {
        const current = await this.store.getQuestion(id);
        if (!current) throw new ProductError('Question not found', 404);
        if (current.answer) return json(current);
        const answered = answeredQuestion(current, body, new Date().toISOString());
        if (answered.answer!.silentSkip) {
          const saved = await this.store.answerQuestion(id, body);
          this.emit(
            { id: saved.sessionId, gezelId: saved.gezelId, projectId: saved.projectId },
            { type: 'question_answered', question: saved },
          );
          return json(saved);
        }
        await this.startTurn(
          current.sessionId,
          { message: formatAnswerSeed(answered) },
          undefined,
          false,
          { id, input: body },
        );
        return json(await this.store.getQuestion(id));
      }
    }
    const taskResponse = await this.tasks.route(method, url.pathname, body, query);
    if (taskResponse) return taskResponse;
    if (resource === 'projects' && id && action === 'craftbooks' && method === 'GET')
      return json({
        items: this.content.craftbooks.map((entry) => entry.item),
        suggestedIds: [],
        missingToolsets: {},
      });
    if (resource === 'health' && method === 'GET')
      return json({
        ok: true,
        version: this.store.version,
        provider: (await this.store.readConfig()).provider,
        capabilities: this.capabilities,
      });
    if (resource === 'config' && !id) {
      if (method === 'PUT') {
        const { externalFolders, ...patch } = UpdateConfigRequestSchema.parse(body);
        if (patch.provider !== undefined) this.assertQuiescent();
        if (externalFolders !== undefined)
          throw new ProductError('External folders are unavailable on this host', 501);
        await this.store.writeConfig(patch);
        const updated = await this.store.readConfig();
        if (!resolveSecurityPolicy(updated).allowAppNetwork) await this.cancelNetworkActivity?.();
        if (!isEngagementAllowed(updated)) await this.cancel();
      }
      const config = await this.store.readConfig();
      return json({
        ...config,
        hasGithubToken: false,
        hasOpenaiApiKey: false,
        hasAnthropicApiKey: false,
        hasGoogleAiApiKey: false,
      });
    }
    if (resource === 'models' && method === 'GET') {
      const providers = await this.providers();
      const provider = providers.find((item) => item.id === query.get('provider'));
      const inventory = provider?.id === 'llama-cpp' ? await this.inference.models?.() : undefined;
      if (id === 'test') {
        if (inventory && !inventory.models.some((model) => model.id === inventory.selectedModelId))
          return json({
            ok: false,
            provider: provider!.id,
            error: inventory.models.length
              ? 'Choose an installed chat model to finish setup.'
              : 'Download or import a chat model to get started.',
          });
        return json(
          provider?.availability === 'available'
            ? { ok: true, provider: provider.id, modelCount: inventory?.models.length ?? 1 }
            : {
                ok: false,
                provider: query.get('provider'),
                error: provider?.reason ?? 'Provider unavailable on this host',
              },
        );
      }
      if (provider?.availability !== 'available')
        return json({ provider: query.get('provider'), models: [] });
      const config = await this.store.readConfig();
      // The window and reply ceiling turns actually get, so the UI and the
      // eval harness never run on a second copy of the budget rules.
      const describe = (id: string, name: string) => {
        let budget: MobileInferenceBudget | undefined;
        try {
          budget = modelBudget(config, provider, inventory, id);
        } catch {
          budget = undefined;
        }
        return {
          id,
          name,
          contextWindow: budget?.contextSize ?? provider.contextTokens,
          ...(budget ? { maxOutputTokens: budget.maxTokens } : {}),
          supportsTools: true,
        };
      };
      return json({
        provider: provider.id,
        models: inventory
          ? inventory.models.map((model) => describe(model.id, model.name))
          : [describe(provider.id, provider.name)],
      });
    }
    if (resource === 'sessions') {
      if (!id) {
        if (method === 'GET')
          return json({
            sessions: await this.store.listSessions({
              gezelId: query.get('gezel') ?? undefined,
              projectId: query.get('project') ?? undefined,
            }),
          });
        if (method === 'POST') {
          const input = CreateChatSessionRequestSchema.parse(body);
          const gezel = await this.store.getGezel(input.gezelId);
          const config = await this.store.readConfig();
          const providerName = MobileProviderIdSchema.parse(
            gezel?.provider ?? config.provider ?? 'llama-cpp',
          );
          const inventory =
            providerName === 'llama-cpp' ? await this.inference.models?.() : undefined;
          const model =
            gezel?.parsed.frontmatter.model ?? inventory?.selectedModelId ?? providerName;
          if (inventory && !inventory.models.some((item) => item.id === model))
            throw new ProductError(
              gezel?.parsed.frontmatter.model
                ? `The model assigned to ${gezel.name} is not installed. Import it in Settings → Artificial Intelligence, or change this gezel's model.`
                : inventory.models.length === 0
                  ? 'No chat model is installed on this device. Download or import one in Settings → Artificial Intelligence, then send your message again.'
                  : 'Choose an available chat model in Settings → Artificial Intelligence, then send your message again.',
              409,
            );
          return json(await this.store.createSession({ ...input, providerName, model }));
        }
      }
      if (id === 'inflight') {
        // A send is in flight from the moment it is accepted, as on desktop:
        // while it is set up, while it waits for the engine, and while it runs.
        const entries = [
          ...[...this.turns.values()].map((t) => ({ session: t.session, startedAt: t.startedAt })),
          ...(
            await Promise.all(
              [...this.admissions.values()]
                .filter((a) => !this.turns.has(a.sessionId))
                .map(async (a) => {
                  const session = await this.session(a.sessionId).catch(() => undefined);
                  return session ? [{ session, startedAt: a.startedAt }] : [];
                }),
            )
          ).flat(),
        ];
        return json({
          inflight: entries
            .filter(
              ({ session }) =>
                (!query.get('project') || query.get('project') === session.projectId) &&
                (!query.get('gezel') || query.get('gezel') === session.gezelId),
            )
            .map(({ session, startedAt }) => ({
              sessionId: session.id,
              gezelId: session.gezelId,
              projectId: session.projectId,
              providerName: session.providerName,
              ...(session.model ? { model: session.model } : {}),
              userText: lastUserText(session),
              startedAt,
              elapsedMs: Date.now() - startedAt,
            })),
        });
      }
      if (id) {
        const session = await this.session(id);
        if (!action && method === 'GET') return json(session);
        if (action === 'inflight') {
          const turn = this.turns.get(id);
          const startedAt = turn?.startedAt ?? this.admissions.get(id)?.startedAt;
          return json({
            inflight:
              startedAt === undefined
                ? null
                : {
                    userText: lastUserText(turn?.session ?? session),
                    startedAt,
                    elapsedMs: Date.now() - startedAt,
                  },
          });
        }
        if (action === 'send' && method === 'POST') return json(await this.submit(id, body));
        if (action === 'interrupt' && method === 'POST')
          return json(await this.interrupt(id, body));
        if (action === 'archive' && method === 'POST') {
          this.assertSessionsFree((scope) => scope.id === id);
          session.archived = true;
          await this.store.writeSession(session);
          return json(session);
        }
        if (!action && method === 'DELETE') {
          this.assertSessionsFree((scope) => scope.id === id);
          await this.store.deleteSession(session.gezelId, id);
          return json({ ok: true });
        }
      }
    }
    if (resource === 'timeline' || action === 'timeline')
      return json(
        await this.timeline(
          query,
          resource === 'projects' ? id : undefined,
          resource === 'gezels' ? id : undefined,
        ),
      );
    // Entity and file dispatch lives below the same public API boundary.
    return this.entities(request, url, body, parts);
  }

  private async timeline(
    query: URLSearchParams,
    projectId?: string,
    gezelId?: string,
  ): Promise<unknown> {
    const summaries = await this.store.listSessions({
      projectId: projectId ?? query.get('project') ?? undefined,
      gezelId: gezelId ?? query.get('gezel') ?? undefined,
    });
    const rows = [];
    for (const summary of summaries) {
      const session = await this.session(summary.id);
      if (session.archived) continue;
      for (const [index, message] of session.messages.entries())
        rows.push({
          ...message,
          _cursor: `${message.at}|${session.id}|${String(index).padStart(8, '0')}`,
          sessionId: session.id,
          gezelId: session.gezelId,
          projectId: session.projectId,
          sessionTitle: session.title,
          sessionCreatedAt: session.createdAt,
          sessionLastActivityAt: session.lastActivityAt,
          sessionProviderName: session.providerName,
          sessionModel: session.model,
          sessionLastTurnError: session.lastTurnError,
        });
    }
    rows.sort((a, b) => a._cursor.localeCompare(b._cursor));
    const before = query.get('before');
    const filtered = rows.filter((row) => !before || row._cursor < before);
    const limit = Math.min(500, Math.max(1, Number(query.get('limit')) || 100));
    const selected = filtered.slice(-limit);
    return {
      messages: selected.map(({ _cursor, ...row }) => row),
      hasMore: filtered.length > limit,
      nextCursor: selected[0]?._cursor,
    };
  }

  /**
   * Pull the text of files a message references.
   *
   * `current` is the message the user just sent: a missing or unreadable file
   * there is worth refusing the turn over, because they can see and fix it.
   * For everything already in the transcript a miss is recorded inline instead,
   * so deleting a file cannot retroactively block a conversation.
   */
  private async attachedText(projectId: string, markdown: string, current = true): Promise<string> {
    const excerpts: string[] = [];
    const seen = new Set<string>();
    for (const match of markdown.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
      let target = match[1]!.replace(/^<|>$/g, '');
      // Test the prefix before decoding: an ordinary link with a stray percent
      // sign is not an attachment, and must not fail the turn.
      if (!/^(?:artifacts|workspace|documents)\//.test(target)) continue;
      try {
        target = decodeURIComponent(target);
      } catch {
        if (current) throw new ProductError('An attachment path is malformed');
        continue;
      }
      if (seen.has(target)) continue;
      seen.add(target);
      if (seen.size > 10) {
        if (current) throw new ProductError('Attach at most ten text files at a time.');
        break;
      }
      const slash = target.indexOf('/');
      const area = target.slice(0, slash) as 'artifacts' | 'workspace' | 'documents';
      const content = await this.store.readFile(
        area,
        area === 'documents' ? undefined : projectId,
        target.slice(slash + 1),
      );
      if (content === null) {
        if (current) throw new ProductError(`Attached file not found: ${target}`, 404);
        excerpts.push(`${target}\n(This file is no longer available.)`);
        continue;
      }
      excerpts.push(`${target}\n${content}`);
    }
    return excerpts.join('\n\n');
  }

  private async entities(
    request: Request,
    url: URL,
    body: Record<string, unknown>,
    parts: string[],
  ): Promise<Response> {
    const [resource, id, action, child, subaction] = parts;
    const method = request.method;
    const query = url.searchParams;
    if (resource === 'projects') {
      if (!id) {
        if (method === 'GET') return json({ projects: await this.store.listProjects() });
        if (method === 'POST') {
          const project = await this.store.createProject(CreateProjectRequestSchema.parse(body));
          this.eventBus.publishProjectEvent(project.id, {
            type: 'project_created',
            projectId: project.id,
            name: project.name,
          });
          return json(project);
        }
      }
      if (id === 'poisoned' && method === 'GET') {
        const poisoned = [];
        for (const summary of await this.store.listSessions()) {
          const session = await this.session(summary.id);
          if (session.lastTurnError && !session.archived)
            poisoned.push({
              projectId: session.projectId,
              sessionId: session.id,
              gezelId: session.gezelId,
              error: session.lastTurnError,
            });
        }
        return json({ poisoned });
      }
      if (id) {
        const project = await this.store.getProject(id);
        if (!project) throw new ProductError('Project not found', 404);
        if (!action) {
          if (method === 'GET') return json(project);
          if (method === 'PUT')
            return json(await this.store.updateProject(id, UpdateProjectRequestSchema.parse(body)));
          if (method === 'DELETE') {
            this.assertSessionsFree((scope) => scope.projectId === id);
            if (this.tasks.isBusy())
              throw new ProductError('Wait for the task step to finish, or stop it first.', 409);
            const deleted = await this.store.deleteProject(id, {
              removeWorkspace: query.get('removeWorkspace') === '1',
            });
            this.eventBus.publishProjectEvent(id, {
              type: 'project_deleted',
              projectId: id,
              name: project.name,
            });
            return json({ ok: true, ...deleted });
          }
        }
        if (action === 'gezels') {
          const gezelId = method === 'POST' ? requiredString(body.gezelId, 'Gezel') : child;
          if (method === 'POST' && gezelId) await this.store.addGezelToProject(id, gezelId);
          if (method === 'DELETE' && gezelId) await this.store.removeGezelFromProject(id, gezelId);
          const current = await this.store.getProject(id);
          return json({
            projectId: id,
            gezelIds: current?.gezelIds ?? [],
            ...(method === 'POST' ? { added: !project.gezelIds?.includes(gezelId!) } : {}),
            ...(method === 'DELETE' ? { removed: project.gezelIds?.includes(gezelId!) } : {}),
          });
        }
        if (action === 'clear-errors' && method === 'POST') {
          let cleared = 0;
          for (const summary of await this.store.listSessions({ projectId: id })) {
            const session = await this.session(summary.id);
            if (session.lastTurnError) {
              delete session.lastTurnError;
              delete session.lastTurnErrorDetail;
              await this.store.writeSession(session);
              cleared++;
            }
          }
          return json({ cleared });
        }
        if (action === 'local-gezels' && method === 'GET' && !child)
          return json({ gezels: await this.store.listProjectLocalGezels(id) });
        if (action === 'workspace' || action === 'artifacts')
          return this.files(request, url, body, action, id, child);
        if (action === 'prompt-drafts') {
          if (
            parts.length > 5 ||
            (subaction &&
              !(
                (method === 'PUT' && subaction === 'content') ||
                (method === 'POST' && subaction === 'duplicate')
              ))
          )
            throw new ProductError('Unsupported prompt draft operation', 501);
          if (!child) {
            if (method === 'GET')
              return json({
                drafts: await this.store.listPromptDrafts(id, {
                  gezelId: query.get('gezelId') ?? undefined,
                  sessionId: query.has('sessionId')
                    ? query.get('sessionId') === 'new'
                      ? null
                      : query.get('sessionId')!
                    : undefined,
                  status:
                    query.get('status') === 'sent'
                      ? 'sent'
                      : query.get('status') === 'draft'
                        ? 'draft'
                        : undefined,
                }),
              });
            if (method === 'POST') {
              const draft = await this.store.createPromptDraft(
                id,
                CreatePromptDraftRequestSchema.parse(body),
              );
              this.draftChanged(draft);
              return json(draft);
            }
          } else {
            if (method === 'GET') {
              const draft = await this.store.getPromptDraft(id, child);
              if (!draft) throw new ProductError('Draft not found', 404);
              return json(draft);
            }
            if (method === 'POST' && subaction === 'duplicate') {
              const draft = await this.store.duplicatePromptDraft(
                id,
                child,
                DuplicatePromptDraftRequestSchema.parse(body),
              );
              this.draftChanged(draft);
              return json(draft);
            }
            if (method === 'PUT' && subaction === 'content') {
              const before = await this.store.getPromptDraft(id, child);
              const result = await this.store.writePromptDraftContent(
                id,
                child,
                z.string().parse(body.content),
              );
              if (result.draft ?? before)
                this.draftChanged((result.draft ?? before)!, result.deleted);
              return json(result);
            }
            if (method === 'PATCH') {
              const draft = await this.store.patchPromptDraft(
                id,
                child,
                PatchPromptDraftRequestSchema.parse(body),
              );
              this.draftChanged(draft);
              return json(draft);
            }
            if (method === 'DELETE') {
              const before = await this.store.getPromptDraft(id, child);
              const deleted = await this.store.deletePromptDraft(id, child);
              if (before && deleted) this.draftChanged(before, true);
              return json({ ok: true, deleted });
            }
          }
        }
      }
    }
    if (resource === 'gezels') {
      if (id && action === 'message' && !child && method === 'POST') {
        this.assertNoConflict();
        if (!isEngagementAllowed(await this.store.readConfig()))
          throw new ProductError(
            'AI engagement is off. Turn it on in Settings to send a message.',
            403,
          );
        const message = MessageGezelRequestSchema.parse(body);
        if (message.suppressReply !== true)
          throw new ProductError(
            'This host supports one-way crew messages. Set suppressReply to true; automatic reply routing requires desktop execution.',
            501,
          );
        const epoch = this.handoffEpoch;
        const check = () => {
          if (epoch !== this.handoffEpoch || this.suspended)
            throw new ProductError('This message was stopped before delivery began.', 409);
        };
        const prepared = await preparePortableMessage(
          this.store,
          id,
          message,
          !!this.scripts,
          check,
        );
        check();
        const delivered = await this.submit(
          prepared.session.id,
          {
            message: `[Message from ${prepared.from.gezelName}]: ${message.text}`,
            fileTurnIntent: message.fileTurnIntent,
          },
          {
            from: prepared.from,
            expectedDeliverable: message.expectedDeliverable,
          },
        );
        return json({
          accepted: true,
          sessionId: prepared.session.id,
          toGezelId: prepared.session.gezelId,
          toGezelName: prepared.toName,
          deliveryState: delivered.queued ? 'queued' : 'dispatched',
        });
      }
      if (!id) {
        if (method === 'GET') return json({ gezels: await this.store.listGezels() });
        if (method === 'POST') {
          const gezel = await this.createGezel(CreateGezelRequestSchema.parse(body));
          this.eventBus.publishGlobalEvent({
            type: 'gezel_created',
            gezelId: gezel.id,
            name: gezel.name,
          });
          return json(gezel);
        }
      }
      if (id === 'mention-candidates' && method === 'GET')
        return json({
          candidates: (await this.store.listGezels())
            .filter(
              (g) =>
                !query.get('query') ||
                `${g.name} ${g.role ?? ''}`
                  .toLowerCase()
                  .includes(query.get('query')!.toLowerCase()),
            )
            .map((g) => ({
              id: g.id,
              label: g.name,
              description: g.role,
              roleBasedName: g.roleBasedName,
              group: 'team',
            })),
        });
      if (id) {
        const gezel = await this.store.getGezel(id);
        if (!gezel) throw new ProductError('Gezel not found', 404);
        if (!action) {
          if (method === 'GET') return json(gezel);
          if (method === 'DELETE') {
            this.assertSessionsFree((scope) => scope.gezelId === id);
            await this.store.deleteGezel(id);
            return json({ ok: true });
          }
        }
        if (action === 'poppetje') {
          if (method === 'GET') return json({ poppetje: await this.store.getGezelPoppetje(id) });
          if (method === 'PUT')
            return json({
              poppetje: await this.store.setGezelPoppetje(
                id,
                UpdateGezelPoppetjeRequestSchema.parse(body).poppetje,
              ),
            });
          if (method === 'POST' && child === 'reroll')
            return json({
              poppetje: await this.store.rerollGezelPoppetje(
                id,
                RerollGezelPoppetjeRequestSchema.parse(body),
              ),
            });
        }
        if (action === 'about' && method === 'PUT')
          return json(await this.store.updateGezelAbout(id, z.string().parse(body.source)));
        if (action === 'md' && method === 'PUT')
          return json(
            await this.store.updateGezelMarkdown(id, requiredString(body.source, 'Character')),
          );
        if (action === 'rename' && method === 'POST')
          return json(
            await this.store.updateGezelSettings(id, { name: requiredString(body.name, 'Name') }),
          );
        if (action === 'settings' && method === 'POST')
          return json(
            await this.store.updateGezelSettings(id, UpdateGezelSettingsRequestSchema.parse(body)),
          );
        if (action === 'projects' && method === 'GET')
          return json({
            projects: (await this.store.listProjects())
              .filter(
                (p) => p.id === 'default' || p.voormanGezelId === id || p.gezelIds?.includes(id),
              )
              .map((p) => ({
                projectId: p.id,
                projectName: p.name,
                precedence: p.voormanGezelId === id ? 'voorman' : 'fallback',
              })),
          });
      }
    }
    if (resource === 'documents') return this.files(request, url, body, 'documents', undefined, id);
    throw new ProductError(
      `This operation is not available on this host: ${request.method} ${url.pathname}`,
      501,
    );
  }

  private async files(
    request: Request,
    url: URL,
    body: Record<string, unknown>,
    area: 'workspace' | 'artifacts' | 'documents',
    projectId: string | undefined,
    action: string | undefined,
  ): Promise<Response> {
    const method = request.method;
    const query = url.searchParams;
    const path = query.get('path') ?? (typeof body.path === 'string' ? body.path : '');
    if (area === 'workspace' && action === 'html-pages' && method === 'GET')
      return json(await portableWorkspaceHtmlPages(this.store, projectId!));
    if (!action && method === 'GET') {
      const result = await this.store.listFiles(
        area,
        projectId,
        path,
        query.get('recursive') === '1',
        { withStats: query.get('stats') === '1', includeHidden: query.get('hidden') === '1' },
      );
      return json({ files: result.entries, truncated: result.truncated });
    }
    if (action === 'read' && method === 'GET') {
      const bytes =
        area === 'documents'
          ? await this.store.readDocumentReference(path)
          : await this.store.readFileBytes(area, projectId, path);
      if (bytes === null) throw new ProductError('File not found', 404);
      if (query.get('raw') === '1')
        return new Response(bytes as Uint8Array<ArrayBuffer>, {
          headers: {
            'content-type': mimeFor(path),
            'content-disposition': 'attachment',
            'x-content-type-options': 'nosniff',
          },
        });
      return json({ path, content: decodeText(bytes), size: bytes.length, kind: 'document' });
    }
    if (action === 'stat' && method === 'GET') {
      const slash = path.lastIndexOf('/');
      const parent = slash < 0 ? '' : path.slice(0, slash);
      const result = await this.store.listFiles(area, projectId, parent, false, {
        withStats: true,
        includeHidden: true,
      });
      const entry = result.entries.find((e) => e.path === path);
      return json(
        entry
          ? {
              kind: entry.isDirectory ? 'dir' : 'file',
              mtime: entry.mtimeMs ? new Date(entry.mtimeMs).toISOString() : undefined,
            }
          : { kind: 'missing' },
      );
    }
    if (['write', 'file'].includes(action ?? '') && method === 'PUT') {
      if (typeof body.content !== 'string') throw new ProductError('File content is required');
      await this.store.writeFile(area, projectId, path, body.content);
      return json({ ok: true, path });
    }
    if (action === 'raw' && method === 'PUT') {
      await this.store.writeFileBytes(
        area,
        projectId,
        path,
        new Uint8Array(await request.arrayBuffer()),
        { createOnly: query.get('create') === '1' },
      );
      return json({ ok: true, path });
    }
    if (action === 'mkdir' && method === 'POST') {
      await this.store.makeFolder(area, projectId, path);
      return json({ ok: true, path });
    }
    if ((action === 'delete' || action === 'path') && method === 'DELETE') {
      await this.store.deleteFile(area, projectId, path);
      return json({ ok: true });
    }
    if (action === 'rename' && method === 'POST') {
      const from = requiredString(body.fromPath, 'Source path');
      const to = requiredString(body.toPath, 'Destination path');
      await this.store.renameFile(area, projectId, from, to);
      return json({ ok: true, fromPath: from, toPath: to });
    }
    throw new ProductError('This file operation is not available on this host', 501);
  }
}
/** The window the device reported it can hold for this model, when it did. */
function fittedContext(
  inventory: MobileModelInventory | undefined,
  modelId: string,
): number | undefined {
  return inventory?.models.find((model) => model.id === modelId)?.contextTokens;
}

/**
 * The window and reply ceiling a turn runs with, and what the model listing
 * reports: the person's per-model choice, else the window this device fits and
 * the default reply budget. A gezel's own reply budget wins over both.
 */
function modelBudget(
  config: Pick<GezelConfig, 'modelContextOverrides' | 'modelTuning'>,
  provider: MobileProvider,
  inventory: MobileModelInventory | undefined,
  modelId: string,
  gezelMaxTokens?: number,
): MobileInferenceBudget {
  return resolveMobileInferenceBudget(provider, {
    contextSize:
      config.modelContextOverrides?.[`${provider.id}:${modelId}`] ??
      fittedContext(inventory, modelId),
    maxTokens: gezelMaxTokens ?? config.modelTuning?.[modelId]?.sampling?.maxTokens,
  });
}

function mimeFor(path: string): string {
  const extension = path.split('.').at(-1)?.toLowerCase();
  const types: Record<string, string> = {
    md: 'text/markdown',
    txt: 'text/plain',
    json: 'application/json',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    pdf: 'application/pdf',
    mp3: 'audio/mpeg',
    mp4: 'video/mp4',
  };
  return types[extension ?? ''] ?? 'application/octet-stream';
}
