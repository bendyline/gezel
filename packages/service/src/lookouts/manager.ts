/**
 * Lookouts: a person's standing instructions to a project — "keep a lookout
 * for the cat squatting in the mud room, then play the alarm and tell me".
 *
 * The engine never calls a model. The camera pipeline asks every armed
 * lookout's question in its own vision review and hands back structured
 * answers; this manager admits a yes against the lookout's limits, records
 * the firing before anything runs, then runs each action on its own — a held
 * email never silences the alarm — and says in plain words why anything was
 * held. A gezel can propose a lookout, never arm or widen one.
 *
 * State lives in the project's private sidecar (`lookouts.json` for what the
 * person set up, `lookout-state.json` for counters and the recent-firings
 * log), never in `project.json`, whose `updatedAt` reads as "activity".
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  CameraEvent,
  ChatEvent,
  GezelConfig,
  Lookout,
  LookoutAction,
  LookoutActionOutcome,
  LookoutCreatedBy,
  LookoutFiring,
  LookoutGateContext,
  LookoutInput,
  LookoutListResponse,
  LookoutStateFile,
  LookoutUpdate,
  Project,
  ProviderName,
} from '@bendyline/gezel';
import {
  KeyedLock,
  LOOKOUT_DAILY_CEILINGS,
  LOOKOUT_FIRING_LOG_LIMIT,
  LOOKOUT_FOLLOW_UP_ACTIONS,
  LOOKOUT_OUTBOUND_ACTIONS,
  LookoutInputSchema,
  LookoutSchema,
  admitLookout,
  createLogger,
  currentCounter,
  isLocalProvider,
  isTaskWorkAllowed,
  localDay,
  lookoutActionGate,
  lookoutAlertText,
  lookoutConditionQuestion,
  lookoutEmailText,
  lookoutGezelSeed,
  lookoutPushText,
  parseCameraBindingConfig,
  projectAcceptsLiveWork,
  projectLeadGezelId,
  resolveSecurityPolicy,
  sanitizeCameraText,
  withinActiveHours,
} from '@bendyline/gezel';
import { writeFileAtomic } from '@bendyline/gezel-inference/internal/fs/atomic';
import type { CameraLookoutView } from '../connectors/live/camera/pipeline.js';
import type { CameraLookoutSink } from '../connectors/live/camera/service.js';
import type { Store } from '../fs/store.js';
import type { HistoryManager } from '../history/manager.js';
import type { SoundPlayer } from './sound-player.js';

const log = createLogger('lookouts');

const ACTION_TIMEOUT_MS = 60_000;
/** Proposals a project may hold unanswered; more would bury the person in cards. */
const MAX_WAITING_PROPOSALS = 5;
const TEST_THROTTLE_MS = 10_000;

/** What a lookout's AI and mail actions need from the rest of the daemon. */
export interface LookoutActionDeps {
  /** Push to the phone channel configured in Settings. */
  push?(text: string): Promise<{ ok: boolean; error?: string }>;
  /** Whether a phone channel is set up at all. */
  pushConfigured?(): Promise<boolean>;
  /** On-device speech for `speak`, as a WAV. */
  speak?(text: string, signal: AbortSignal): Promise<Buffer>;
  /** Draft, then commit, a mail send through a bound mail connector. */
  email?(input: {
    projectId: string;
    bindingId: string;
    recipients: string[];
    subject: string;
    body: string;
    lookoutId: string;
  }): Promise<'sent' | 'queued'>;
  deliverReaction?(args: {
    projectId: string;
    gezelId: string;
    seed: string;
    standalone: boolean;
  }): Promise<{ sessionId: string } | null>;
  providerForGezel?(gezelId: string): Promise<ProviderName>;
  gezelName?(gezelId: string): Promise<string | undefined>;
  /** Who would own a run of this book (the entry role's gezel, else the lead). */
  craftbookOwner?(projectId: string, craftbookId: string): Promise<string | undefined>;
  craftbookExists?(projectId: string, craftbookId: string): Promise<boolean>;
  /** The book's first file-input parameter, for the episode's pictures. */
  craftbookInputParam?(projectId: string, craftbookId: string): Promise<string | undefined>;
  runCraftbook?(input: {
    projectId: string;
    craftbookId: string;
    params: Record<string, string>;
    inputs?: Record<string, { from: 'artifacts'; path: string }>;
    origin: { kind: 'lookout'; lookoutId: string; firingId: string; episodeId: string };
    title: string;
    description: string;
  }): Promise<{ taskRef: string }>;
  /** A run this lookout started is still going. */
  liveRunFor?(projectId: string, lookoutId: string): Promise<boolean>;
}

export interface LookoutManagerOptions extends LookoutActionDeps {
  home: string;
  store: Pick<
    Store,
    | 'listProjects'
    | 'getProject'
    | 'readConfig'
    | 'listLookouts'
    | 'writeLookouts'
    | 'readLookoutState'
    | 'writeLookoutState'
  >;
  history?: Pick<HistoryManager, 'log'>;
  publishProject(projectId: string, event: ChatEvent): void;
  publishGlobal(event: ChatEvent): void;
  sound: SoundPlayer;
  now?(): Date;
}

interface DailyTotals {
  day: string;
  firings: number;
  outbound: number;
  followUps: number;
}

const ACTION_LABEL: Record<LookoutAction['kind'], string> = {
  notify: 'Notification',
  sound: 'Sound',
  speak: 'Spoken alert',
  push: 'Phone',
  email: 'Email',
  'ask-gezel': 'Ask a gezel',
  'run-craftbook': 'Craftbook',
};

export class LookoutManager implements CameraLookoutSink {
  private readonly cache = new Map<string, Lookout[]>();
  private readonly locks = new KeyedLock();
  private readonly lastTest = new Map<string, number>();
  private daily: DailyTotals | null = null;
  private loaded = false;
  private readonly pending = new Set<Promise<unknown>>();

  constructor(private readonly opts: LookoutManagerOptions) {}

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  /** Read every project's lookouts so the camera can ask synchronously. */
  async load(): Promise<void> {
    const projects = await this.opts.store.listProjects().catch(() => [] as Project[]);
    for (const p of projects) {
      this.cache.set(p.id, await this.opts.store.listLookouts(p.id).catch(() => []));
    }
    this.loaded = true;
  }

  // ── CameraLookoutSink ────────────────────────────────────────────────

  view(projectId: string, bindingId: string): CameraLookoutView {
    const now = this.now();
    const questions: CameraLookoutView['questions'] = [];
    let motion = false;
    for (const lk of this.cache.get(projectId) ?? []) {
      if (!this.armedFor(lk, bindingId, now)) continue;
      const question = lookoutConditionQuestion(lk.condition);
      if (question) questions.push({ id: lk.id, question });
      else motion = true;
    }
    return { questions, motion };
  }

  lookoutName(projectId: string, lookoutId: string): string | undefined {
    return this.cache.get(projectId)?.find((l) => l.id === lookoutId)?.name;
  }

  accept(event: CameraEvent): void {
    const relevant = (this.cache.get(event.projectId) ?? []).some(
      (l) =>
        l.source.kind === 'camera' && l.source.bindingId === event.bindingId && l.state === 'armed',
    );
    if (!relevant) return;
    const work = this.locks
      .run(event.projectId, () => this.handle(event))
      .catch((err) => log.warn('lookout handling failed:', err));
    this.pending.add(work);
    void work.finally(() => this.pending.delete(work));
  }

  /** Resolves once every accepted event has been handled (tests, shutdown). */
  async whenIdle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  private armedFor(lk: Lookout, bindingId: string, now: Date): boolean {
    return (
      lk.state === 'armed' &&
      lk.enabled &&
      lk.source.kind === 'camera' &&
      lk.source.bindingId === bindingId &&
      !(lk.snoozedUntil && Date.parse(lk.snoozedUntil) > now.getTime()) &&
      withinActiveHours(lk.activeHours, now)
    );
  }

  // ── Reading and editing ──────────────────────────────────────────────

  async list(projectId: string): Promise<LookoutListResponse> {
    const [lookouts, state, config] = await Promise.all([
      this.opts.store.listLookouts(projectId),
      this.opts.store.readLookoutState(projectId),
      this.opts.store.readConfig(),
    ]);
    this.cache.set(projectId, lookouts);
    const now = this.now();
    return {
      lookouts: lookouts.map((l) => {
        const counter = currentCounter(state.counters[l.id], now);
        return {
          ...l,
          firedToday: counter.fired,
          ...(counter.lastFiredAt ? { lastFiredAt: counter.lastFiredAt } : {}),
        };
      }),
      firings: [...state.firings].reverse(),
      paused: config.lookouts?.paused === true,
    };
  }

  /**
   * Create a lookout. A person's is armed at once; a gezel's proposal is
   * stored `proposed` and disabled until the person approves it.
   */
  async create(
    projectId: string,
    input: LookoutInput,
    createdBy: LookoutCreatedBy = { kind: 'person' },
  ): Promise<Lookout> {
    const parsed = LookoutInputSchema.parse(input);
    await this.validate(projectId, parsed);
    return this.locks.run(projectId, async () => {
      const lookouts = await this.opts.store.listLookouts(projectId);
      const at = this.now().toISOString();
      const proposed = createdBy.kind === 'gezel';
      if (
        proposed &&
        lookouts.filter((l) => l.state === 'proposed').length >= MAX_WAITING_PROPOSALS
      ) {
        throw new Error(
          'Several proposed lookouts are already waiting for the person; ask them to review those first.',
        );
      }
      const lookout = LookoutSchema.parse({
        id: `lk-${randomUUID().slice(0, 8)}`,
        name: parsed.name,
        enabled: !proposed,
        state: proposed ? 'proposed' : 'armed',
        source: parsed.source,
        condition: parsed.condition,
        actions: parsed.actions,
        limits: { cooldownMinutes: 10, maxPerDay: 12, followUpsPerDay: 4, ...parsed.limits },
        ...(parsed.activeHours ? { activeHours: parsed.activeHours } : {}),
        createdBy,
        createdAt: at,
        updatedAt: at,
      });
      await this.save(projectId, [...lookouts, lookout]);
      await this.logChange(projectId, lookout, proposed ? 'proposed' : 'created');
      return lookout;
    });
  }

  async update(projectId: string, lookoutId: string, patch: LookoutUpdate): Promise<Lookout> {
    return this.locks.run(projectId, async () => {
      const lookouts = await this.opts.store.listLookouts(projectId);
      const current = lookouts.find((l) => l.id === lookoutId);
      if (!current) throw new LookoutNotFoundError(lookoutId);
      const merged: LookoutInput = {
        name: patch.name ?? current.name,
        source: patch.source ?? current.source,
        condition: patch.condition ?? current.condition,
        actions: patch.actions ?? current.actions,
        limits: { ...current.limits, ...patch.limits },
        ...(patch.activeHours === null
          ? {}
          : patch.activeHours
            ? { activeHours: patch.activeHours }
            : current.activeHours
              ? { activeHours: current.activeHours }
              : {}),
      };
      await this.validate(projectId, LookoutInputSchema.parse(merged));
      const { activeHours: _drop, ...rest } = current;
      const next = LookoutSchema.parse({
        ...rest,
        ...merged,
        limits: { ...current.limits, ...patch.limits },
        // Turning a proposal on is approving it — the person is the one
        // pressing the switch.
        ...(patch.enabled !== undefined
          ? {
              enabled: patch.enabled,
              ...(patch.enabled && current.state === 'proposed' ? { state: 'armed' } : {}),
            }
          : {}),
        updatedAt: this.now().toISOString(),
      });
      await this.save(
        projectId,
        lookouts.map((l) => (l.id === lookoutId ? next : l)),
      );
      await this.logChange(projectId, next, 'edited');
      return next;
    });
  }

  /** The person approves a gezel's proposal: it becomes theirs and starts. */
  async approve(projectId: string, lookoutId: string): Promise<Lookout> {
    return this.update(projectId, lookoutId, { enabled: true });
  }

  async remove(projectId: string, lookoutId: string): Promise<void> {
    await this.locks.run(projectId, async () => {
      const lookouts = await this.opts.store.listLookouts(projectId);
      const gone = lookouts.find((l) => l.id === lookoutId);
      if (!gone) throw new LookoutNotFoundError(lookoutId);
      await this.save(
        projectId,
        lookouts.filter((l) => l.id !== lookoutId),
      );
      const state = await this.opts.store.readLookoutState(projectId);
      if (state.counters[lookoutId]) {
        delete state.counters[lookoutId];
        await this.opts.store.writeLookoutState(projectId, state);
      }
      await this.logChange(projectId, gone, 'removed');
    });
  }

  /** Snooze for `minutes`, or clear the snooze with null. */
  async snooze(projectId: string, lookoutId: string, minutes: number | null): Promise<Lookout> {
    return this.locks.run(projectId, async () => {
      const lookouts = await this.opts.store.listLookouts(projectId);
      const current = lookouts.find((l) => l.id === lookoutId);
      if (!current) throw new LookoutNotFoundError(lookoutId);
      const { snoozedUntil: _old, ...rest } = current;
      const next: Lookout = {
        ...rest,
        ...(minutes && minutes > 0
          ? { snoozedUntil: new Date(this.now().getTime() + minutes * 60_000).toISOString() }
          : {}),
        updatedAt: this.now().toISOString(),
      };
      await this.save(
        projectId,
        lookouts.map((l) => (l.id === lookoutId ? next : l)),
      );
      return next;
    });
  }

  async feedback(
    projectId: string,
    firingId: string,
    feedback: 'false-alarm' | null,
  ): Promise<void> {
    await this.locks.run(projectId, async () => {
      const state = await this.opts.store.readLookoutState(projectId);
      const firing = state.firings.find((f) => f.id === firingId);
      if (!firing) throw new LookoutNotFoundError(firingId);
      if (feedback) firing.feedback = feedback;
      else delete firing.feedback;
      await this.opts.store.writeLookoutState(projectId, state);
      this.opts.publishProject(projectId, { type: 'lookouts_updated', projectId });
    });
  }

  /**
   * Fire a lookout's actions now, as a rehearsal: sounds and notifications
   * are real, mail says "[Test]", and AI actions report what they would do
   * without starting any work. Counts toward no limit.
   */
  async test(projectId: string, lookoutId: string): Promise<LookoutFiring> {
    const last = this.lastTest.get(lookoutId) ?? 0;
    if (this.now().getTime() - last < TEST_THROTTLE_MS) {
      throw new Error('Wait a few seconds before testing this lookout again.');
    }
    this.lastTest.set(lookoutId, this.now().getTime());
    return this.locks.run(projectId, async () => {
      const lookout = (await this.opts.store.listLookouts(projectId)).find(
        (l) => l.id === lookoutId,
      );
      if (!lookout) throw new LookoutNotFoundError(lookoutId);
      const project = await this.opts.store.getProject(projectId);
      const label =
        project?.connectors?.find((b) => b.id === lookout.source.bindingId)?.displayName ??
        'Camera';
      const event: CameraEvent = {
        projectId,
        bindingId: lookout.source.bindingId,
        cameraLabel: label,
        episodeId: `test-${randomUUID().slice(0, 8)}`,
        phase: 'reviewed',
        at: this.now().toISOString(),
        startedAt: this.now().toISOString(),
        motionPeak: 0,
        presence: false,
        keyframePaths: [],
      };
      const state = await this.opts.store.readLookoutState(projectId);
      return this.fire(lookout, event, undefined, state, { test: true });
    });
  }

  stopSounds(): number {
    return this.opts.sound.stopAll();
  }

  /**
   * Alerts fired since `sinceMs`, as the events that announced them. The
   * desktop app asks on (re)connect, because chat events are not replayed
   * and an alarm missed during a reconnect is an alarm missed.
   */
  async recentAlerts(
    sinceMs: number,
  ): Promise<Array<Extract<ChatEvent, { type: 'lookout_fired' }>>> {
    if (!this.loaded) await this.load();
    const out: Array<Extract<ChatEvent, { type: 'lookout_fired' }>> = [];
    for (const [projectId, lookouts] of this.cache) {
      if (lookouts.length === 0) continue;
      const [state, project] = await Promise.all([
        this.opts.store.readLookoutState(projectId),
        this.opts.store.getProject(projectId),
      ]);
      for (const f of state.firings) {
        if (Date.parse(f.at) < sinceMs) continue;
        const lookout = lookouts.find((l) => l.id === f.lookoutId);
        if (!lookout?.actions.some((a) => a.kind === 'notify')) continue;
        const cameraLabel =
          project?.connectors?.find((b) => b.id === f.bindingId)?.displayName ?? 'Camera';
        out.push({
          type: 'lookout_fired',
          projectId,
          lookoutId: f.lookoutId,
          firingId: f.id,
          name: f.lookoutName,
          at: f.at,
          alert: lookoutAlertText({
            lookoutName: f.test ? `Test: ${f.lookoutName}` : f.lookoutName,
            cameraLabel,
            at: new Date(f.at),
            ...(f.summary ? { summary: f.summary } : {}),
          }),
          ...(f.frame ? { frame: f.frame } : {}),
          ...(f.test ? { test: true } : {}),
        });
      }
    }
    return out.sort((a, b) => a.at.localeCompare(b.at));
  }

  // ── Firing ───────────────────────────────────────────────────────────

  private async handle(event: CameraEvent): Promise<void> {
    if (!this.loaded) await this.load();
    const config = await this.opts.store.readConfig();
    if (config.lookouts?.paused) return;
    // Lookouts act; Chat-only engagement holds autonomous action, Off holds
    // everything. Sound and notify are what the person asked for, but they
    // still wait under emergency stop (which leaves the mode reactive).
    if (!isTaskWorkAllowed(config)) return;
    const project = await this.opts.store.getProject(event.projectId);
    if (!project || !projectAcceptsLiveWork(project)) return;
    const lookouts = await this.opts.store.listLookouts(event.projectId);
    this.cache.set(event.projectId, lookouts);
    const state = await this.opts.store.readLookoutState(event.projectId);
    const now = this.now();
    let dirty = false;
    for (const lookout of lookouts) {
      if (lookout.source.kind !== 'camera' || lookout.source.bindingId !== event.bindingId)
        continue;
      const decision = admitLookout(lookout, state.counters[lookout.id], event, now);
      if (decision.counter) {
        state.counters[lookout.id] = decision.counter;
        dirty = true;
      }
      if (!decision.fire) continue;
      if (!this.underDailyFiringCeiling(now)) {
        log.info(`lookout ${lookout.id} matched, but the install reached today's firing ceiling`);
        continue;
      }
      await this.fire(lookout, event, decision.frame, state, { test: false, config, project });
      dirty = false;
    }
    if (dirty) await this.opts.store.writeLookoutState(event.projectId, state);
  }

  private async fire(
    lookout: Lookout,
    event: CameraEvent,
    frame: string | undefined,
    state: LookoutStateFile,
    ctx: { test: boolean; config?: GezelConfig; project?: Project },
  ): Promise<LookoutFiring> {
    const projectId = event.projectId;
    const at = this.now();
    const summary = sanitizeCameraText(event.review?.summary);
    const firing: LookoutFiring = {
      id: `fr-${randomUUID().slice(0, 8)}`,
      lookoutId: lookout.id,
      lookoutName: lookout.name,
      projectId,
      bindingId: event.bindingId,
      episodeId: event.episodeId,
      at: at.toISOString(),
      ...(ctx.test ? { test: true } : {}),
      ...(frame ? { frame } : {}),
      ...(summary ? { summary } : {}),
      outcomes: [],
      settled: false,
    };
    // The firing is on disk before anything runs, so a crash mid-action
    // leaves a record that says so rather than a silent gap.
    state.firings = [...state.firings, firing].slice(-LOOKOUT_FIRING_LOG_LIMIT);
    await this.opts.store.writeLookoutState(projectId, state);
    if (!ctx.test) await this.bumpDaily({ firings: 1 });

    const textInput = {
      lookoutName: ctx.test ? `Test: ${lookout.name}` : lookout.name,
      cameraLabel: event.cameraLabel,
      at,
      ...(summary ? { summary } : {}),
    };
    const hasNotify = lookout.actions.some((a) => a.kind === 'notify');
    const hasSound = lookout.actions.some((a) => a.kind === 'sound' || a.kind === 'speak');
    this.opts.publishGlobal({
      type: 'lookout_fired',
      projectId,
      lookoutId: lookout.id,
      firingId: firing.id,
      name: lookout.name,
      at: firing.at,
      ...(hasNotify ? { alert: lookoutAlertText(textInput) } : {}),
      ...(frame ? { frame } : {}),
      ...(ctx.test ? { test: true } : {}),
      ...(hasSound ? { sound: true } : {}),
    });

    const gate = await this.gateContext(lookout, event, ctx.config, ctx.project);
    const outcomes = await Promise.all(
      lookout.actions.map((action) =>
        this.runAction(lookout, action, event, firing, gate, textInput, ctx.test).catch(
          (err): LookoutActionOutcome => ({
            action: action.kind,
            status: 'failed',
            reason: err instanceof Error ? err.message.slice(0, 200) : String(err),
          }),
        ),
      ),
    );

    const latest = await this.opts.store.readLookoutState(projectId);
    const entry = latest.firings.find((f) => f.id === firing.id);
    if (entry) {
      entry.outcomes = outcomes;
      entry.settled = true;
    }
    if (!ctx.test) {
      const counter = currentCounter(latest.counters[lookout.id] ?? state.counters[lookout.id], at);
      const followUps = outcomes.filter(
        (o) =>
          o.status === 'done' && LOOKOUT_FOLLOW_UP_ACTIONS.has(o.action as LookoutAction['kind']),
      ).length;
      counter.followUps += followUps;
      latest.counters[lookout.id] = { ...state.counters[lookout.id], ...counter };
    }
    await this.opts.store.writeLookoutState(projectId, latest);
    // The caller's copy must not overwrite what we just wrote.
    Object.assign(state, latest);
    this.opts.publishProject(projectId, { type: 'lookouts_updated', projectId });

    const allHeld = outcomes.every((o) => o.status !== 'done');
    await this.opts.history
      ?.log({
        kind: allHeld ? 'lookout.held' : 'lookout.fired',
        projectId,
        summary: `${ctx.test ? 'Tested' : allHeld ? 'Held' : 'Fired'} lookout: ${lookout.name}`,
        details: {
          lookoutId: lookout.id,
          firingId: firing.id,
          bindingId: event.bindingId,
          episodeId: event.episodeId,
          ...(ctx.test ? { test: true } : {}),
          outcomes,
        },
      })
      .catch(() => {});
    return { ...firing, outcomes, settled: true };
  }

  private async gateContext(
    lookout: Lookout,
    event: CameraEvent,
    config?: GezelConfig,
    project?: Project,
  ): Promise<Omit<LookoutGateContext, 'actingProvider'> & { lead?: string }> {
    const cfg = config ?? (await this.opts.store.readConfig());
    const proj = project ?? (await this.opts.store.getProject(event.projectId)) ?? undefined;
    const policy = resolveSecurityPolicy(cfg);
    const binding = proj?.connectors?.find((b) => b.id === event.bindingId);
    const daily = await this.dailyTotals();
    const counter = currentCounter(
      (await this.opts.store.readLookoutState(event.projectId)).counters[lookout.id],
      this.now(),
    );
    const lead = proj ? projectLeadGezelId(proj, cfg.meesterGezelId) : undefined;
    return {
      workAllowed: isTaskWorkAllowed(cfg),
      allowMail: policy.allowMail,
      allowAppNetwork: policy.allowAppNetwork,
      pushConfigured: (await this.opts.pushConfigured?.().catch(() => false)) ?? false,
      outboundUsedToday: daily.outbound,
      followUpsUsedToday: daily.followUps,
      lookoutFollowUpsToday: counter.followUps,
      lookoutFollowUpsPerDay: lookout.limits.followUpsPerDay,
      cameraAllowsCloud: binding
        ? parseCameraBindingConfig(binding.config).allowCloudModels
        : false,
      ...(lead ? { lead } : {}),
    };
  }

  private async actingProvider(
    gezelId: string | undefined,
  ): Promise<LookoutGateContext['actingProvider']> {
    if (!gezelId || !this.opts.providerForGezel) return null;
    const provider = await this.opts.providerForGezel(gezelId).catch(() => null);
    if (!provider) return null;
    const name = await this.opts.gezelName?.(gezelId).catch(() => undefined);
    return {
      local: isLocalProvider(provider),
      label: provider,
      ...(name ? { gezelName: name } : {}),
    };
  }

  private async runAction(
    lookout: Lookout,
    action: LookoutAction,
    event: CameraEvent,
    firing: LookoutFiring,
    gate: Omit<LookoutGateContext, 'actingProvider'> & { lead?: string },
    text: Parameters<typeof lookoutAlertText>[0],
    test: boolean,
  ): Promise<LookoutActionOutcome> {
    const kind = action.kind;
    const label = ACTION_LABEL[kind];
    let actingGezel: string | undefined;
    if (action.kind === 'ask-gezel') actingGezel = action.gezelId ?? gate.lead;
    if (action.kind === 'run-craftbook') {
      actingGezel = await this.opts
        .craftbookOwner?.(event.projectId, action.craftbookId)
        .catch(() => undefined);
    }
    const verdict = lookoutActionGate(action, {
      ...gate,
      actingProvider: LOOKOUT_FOLLOW_UP_ACTIONS.has(kind)
        ? await this.actingProvider(actingGezel)
        : null,
    });
    if (!verdict.ok) return { action: kind, status: 'held', reason: verdict.reason };

    const outcome = await withTimeout(
      this.perform(lookout, action, event, firing, text, test, actingGezel),
      ACTION_TIMEOUT_MS,
      `${label} took too long.`,
    );
    if (!test && outcome.status === 'done' && LOOKOUT_OUTBOUND_ACTIONS.has(kind)) {
      await this.bumpDaily({ outbound: 1 });
    }
    if (!test && outcome.status === 'done' && LOOKOUT_FOLLOW_UP_ACTIONS.has(kind)) {
      await this.bumpDaily({ followUps: 1 });
    }
    return outcome;
  }

  private async perform(
    lookout: Lookout,
    action: LookoutAction,
    event: CameraEvent,
    firing: LookoutFiring,
    text: Parameters<typeof lookoutAlertText>[0],
    test: boolean,
    actingGezel: string | undefined,
  ): Promise<LookoutActionOutcome> {
    const kind = action.kind;
    switch (action.kind) {
      case 'notify':
        // The `lookout_fired` event already carries the alert; the desktop
        // app turns it into a notification (or an in-app alert).
        return { action: kind, status: 'done' };
      case 'sound':
        await this.opts.sound.playClip(action.clip);
        return { action: kind, status: 'done' };
      case 'speak': {
        if (!this.opts.speak) {
          await this.opts.sound.playClip('chime');
          return {
            action: kind,
            status: 'done',
            reason: 'Spoken alerts need on-device speech; played the chime.',
          };
        }
        try {
          const ctrl = new AbortController();
          const wav = await this.opts.speak(action.text, ctrl.signal);
          const dir = join(this.opts.home, 'lookouts', 'speech');
          await mkdir(dir, { recursive: true });
          const path = join(dir, `${lookout.id}.wav`);
          await writeFileAtomic(path, wav);
          await this.opts.sound.playFile(path, `speak:${action.text}`);
        } catch {
          await this.opts.sound.playClip('chime');
          return {
            action: kind,
            status: 'done',
            reason: 'Speech was unavailable; played the chime.',
          };
        }
        return { action: kind, status: 'done' };
      }
      case 'push': {
        if (!this.opts.push)
          return {
            action: kind,
            status: 'held',
            reason: 'No phone channel is set up in Settings.',
          };
        const result = await this.opts.push(`${test ? '[Test] ' : ''}${lookoutPushText(text)}`);
        return result.ok
          ? { action: kind, status: 'done' }
          : {
              action: kind,
              status: 'failed',
              reason: result.error ?? 'The phone channel refused the message.',
            };
      }
      case 'email': {
        if (!this.opts.email)
          return { action: kind, status: 'held', reason: 'Email is not available.' };
        const mail = lookoutEmailText(text);
        const result = await this.opts.email({
          projectId: event.projectId,
          bindingId: action.bindingId,
          recipients: action.recipients,
          subject: `${test ? '[Test] ' : ''}${mail.subject}`,
          body: mail.body,
          lookoutId: lookout.id,
        });
        return result === 'sent'
          ? { action: kind, status: 'done' }
          : { action: kind, status: 'held', reason: 'Queued in the outbox for your review.' };
      }
      case 'ask-gezel': {
        if (!actingGezel)
          return { action: kind, status: 'held', reason: 'No gezel is available to take this on.' };
        if (test) return { action: kind, status: 'skipped', reason: 'Not sent on a test.' };
        if (!this.opts.deliverReaction)
          return { action: kind, status: 'held', reason: 'Gezels are not available.' };
        const seed = lookoutGezelSeed({
          ...text,
          instruction: action.instruction,
          frames: event.keyframePaths,
          ...(event.recordPath ? { recordPath: event.recordPath } : {}),
        });
        const delivered = await this.opts.deliverReaction({
          projectId: event.projectId,
          gezelId: actingGezel,
          seed,
          standalone: true,
        });
        return delivered
          ? { action: kind, status: 'done' }
          : { action: kind, status: 'held', reason: 'AI engagement is off.' };
      }
      case 'run-craftbook': {
        if (test) return { action: kind, status: 'skipped', reason: 'Not started on a test.' };
        if (!this.opts.runCraftbook)
          return { action: kind, status: 'held', reason: 'Craftbooks are not available.' };
        if (await this.opts.liveRunFor?.(event.projectId, lookout.id).catch(() => false)) {
          return {
            action: kind,
            status: 'skipped',
            reason: 'A run this lookout started is still going.',
          };
        }
        const inputParam = event.attachmentsDir
          ? await this.opts
              .craftbookInputParam?.(event.projectId, action.craftbookId)
              .catch(() => undefined)
          : undefined;
        const run = await this.opts.runCraftbook({
          projectId: event.projectId,
          craftbookId: action.craftbookId,
          params: action.params ?? {},
          ...(inputParam && event.attachmentsDir
            ? {
                inputs: {
                  [inputParam]: { from: 'artifacts' as const, path: event.attachmentsDir },
                },
              }
            : {}),
          origin: {
            kind: 'lookout',
            lookoutId: lookout.id,
            firingId: firing.id,
            episodeId: event.episodeId,
          },
          title: `${lookout.name} — ${event.cameraLabel}, ${new Date(firing.at).toLocaleString()}`,
          description: `The "${lookout.name}" lookout saw something on ${event.cameraLabel} and started this run. The episode's pictures and notes are the input${event.recordPath ? `; the event record is \`${event.recordPath}\`` : ''}.`,
        });
        return { action: kind, status: 'done', reason: `Started ${run.taskRef}.` };
      }
    }
  }

  // ── Persistence helpers ──────────────────────────────────────────────

  private async save(projectId: string, lookouts: Lookout[]): Promise<void> {
    await this.opts.store.writeLookouts(projectId, lookouts);
    this.cache.set(projectId, lookouts);
    this.opts.publishProject(projectId, { type: 'lookouts_updated', projectId });
  }

  private async validate(projectId: string, input: LookoutInput): Promise<void> {
    const project = await this.opts.store.getProject(projectId);
    if (!project) throw new Error(`project not found: ${projectId}`);
    const camera = project.connectors?.find((b) => b.id === input.source.bindingId);
    if (!camera || camera.driver !== 'device') {
      throw new Error('A lookout watches a camera connected to this project.');
    }
    for (const action of input.actions) {
      if (action.kind === 'email') {
        const mail = project.connectors?.find((b) => b.id === action.bindingId);
        if (!mail || !mail.type.startsWith('mail-')) {
          throw new Error('Email needs a mail account connected to this project.');
        }
      }
      if (action.kind === 'run-craftbook' && this.opts.craftbookExists) {
        if (!(await this.opts.craftbookExists(projectId, action.craftbookId))) {
          throw new Error(`unknown craftbook "${action.craftbookId}"`);
        }
      }
    }
  }

  private async logChange(projectId: string, lookout: Lookout, verb: string): Promise<void> {
    await this.opts.history
      ?.log({
        kind: 'lookout.changed',
        projectId,
        summary: `Lookout ${verb}: ${lookout.name}`,
        details: {
          lookoutId: lookout.id,
          change: verb,
          state: lookout.state,
          enabled: lookout.enabled,
        },
      })
      .catch(() => {});
  }

  private dailyPath(): string {
    return join(this.opts.home, 'lookouts', 'daily.json');
  }

  private async dailyTotals(): Promise<DailyTotals> {
    const today = localDay(this.now());
    if (this.daily?.day === today) return this.daily;
    try {
      const raw = JSON.parse(await readFile(this.dailyPath(), 'utf8')) as Partial<DailyTotals>;
      if (raw.day === today) {
        this.daily = {
          day: today,
          firings: Number(raw.firings) || 0,
          outbound: Number(raw.outbound) || 0,
          followUps: Number(raw.followUps) || 0,
        };
        return this.daily;
      }
    } catch {
      /* first firing today */
    }
    this.daily = { day: today, firings: 0, outbound: 0, followUps: 0 };
    return this.daily;
  }

  private underDailyFiringCeiling(now: Date): boolean {
    const d = this.daily;
    if (!d || d.day !== localDay(now)) return true;
    return d.firings < LOOKOUT_DAILY_CEILINGS.firings;
  }

  /**
   * Install-wide counts, on disk so a restart loop cannot reset the budget
   * that keeps lookouts from becoming a mail cannon.
   */
  private async bumpDaily(add: Partial<Omit<DailyTotals, 'day'>>): Promise<void> {
    const d = await this.dailyTotals();
    d.firings += add.firings ?? 0;
    d.outbound += add.outbound ?? 0;
    d.followUps += add.followUps ?? 0;
    await mkdir(join(this.opts.home, 'lookouts'), { recursive: true });
    await writeFileAtomic(this.dailyPath(), `${JSON.stringify(d)}\n`).catch(() => {});
  }
}

export class LookoutNotFoundError extends Error {
  constructor(id: string) {
    super(`lookout not found: ${id}`);
    this.name = 'LookoutNotFoundError';
  }
}

function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
    work.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
