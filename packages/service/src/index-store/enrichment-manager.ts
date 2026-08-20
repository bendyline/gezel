import {
  type GezelDetail,
  type HistoryEvent,
  createLogger,
  isSharedLibraryProject,
} from '@bendyline/gezel';
import type { ChatEventBus } from '../chat/events.js';
import type { ChatManager } from '../chat/manager.js';
import type { Store } from '../fs/store.js';
import { resolveProjectBoekwachter } from '../gezels/autonomous-roles.js';
import { embeddingsDisabledReason } from '../memory/embeddings.js';
import type { SystemIdleState } from '../system/idle-state.js';
import type { AiShadowProducers } from './ai-shadow.js';
import type { ContentIndex } from './content-index.js';
import { type EnrichDeps, buildEnrichDeps } from './enrich.js';
import { type ResolvedRubric, resolveRubrics } from './rubrics.js';

/**
 * Background "boekwachter" enrichment loop. When the machine is idle, it picks a
 * project with un-enriched files and computes summaries (local LLM, best-effort)
 * + embeddings (local transformers.js) for a small batch, then yields. Mirrors
 * WorkspaceIndexManager's lifecycle (deferred start + unref'd interval + skip
 * while chat is active) so it never competes with live work.
 *
 * Two idle gates, both must pass:
 *   1. session idle — no chat turn in flight anywhere (`chat.isAnyActive`)
 *   2. OS idle — `SystemIdleState` reports ≥ threshold (null/unknown ⇒ allowed)
 */

const log = createLogger('enrich');

const STARTUP_DELAY_MS = 20_000;
const TICK_INTERVAL_MS = 120_000;
const OS_IDLE_THRESHOLD_MS = 3 * 60_000;
const BATCH = 5;
// Night shift is the explicit bulk window: bigger batches, drain project after
// project until the wall-clock budget for one tick runs out (the interval then
// re-fires, so the shift sustains ~BUDGET/INTERVAL duty cycle all night).
const NIGHT_BATCH = 25;
const NIGHT_TICK_BUDGET_MS = 90_000;
// Embed-only tier batch (day). Larger than BATCH because it makes no LLM
// calls — the local embeddings worker is the only cost — but still bounded so
// a tick stays polite on shared hardware.
const EMBED_ONLY_BATCH = 10;

export interface IndexEnrichmentActivity {
  id: 'index-enrichment';
  title: 'Workspace indexing';
  detail: string;
  projectId?: string;
  projectName?: string;
}

export interface IndexEnrichmentManagerOptions {
  store: Store;
  chat: ChatManager;
  contentIndex: ContentIndex;
  idle: SystemIdleState;
  intervalMs?: number;
  startupDelayMs?: number;
  osIdleThresholdMs?: number;
  /**
   * Synchronous read of Night Shift active state. While ON, the OS-idle
   * threshold is skipped — night shift is the explicit "do background work
   * now" signal — though the no-chat-turn-in-flight gate still applies.
   * Defaults to always-off.
   */
  isNightShiftActive?: () => boolean;
  /**
   * The indexing job's pause switch — wired to the system "nachtwacht" task's
   * status so pausing that task in the Tasks UI genuinely stops this loop.
   * Defaults to never-paused.
   */
  isPaused?: () => Promise<boolean> | boolean;
  /** Chat event bus for `index_progress` heartbeats (optional in tests). */
  events?: Pick<ChatEventBus, 'publishGlobalEvent'>;
  /** Test seam; production resolves the role from each project's roster. */
  resolveBoekwachter?: (projectId: string) => Promise<GezelDetail | null>;
  /**
   * AI-shadow producers (vision describe / STT transcribe). Absent when the
   * install has neither capability; the shadow tier is skipped entirely then.
   */
  shadowProducers?: AiShadowProducers;
  /** Audit log for the once-per-wave `project.index.reviewed` drain event. */
  history?: {
    log: (event: Omit<HistoryEvent, 'id' | 'at'> & { at?: string; id?: string }) => Promise<void>;
  };
  /**
   * Awaitable structural refresh (WorkspaceIndexManager.refreshAndWait) run
   * at the head of every drive so the AI tiers see current files. When
   * absent (tests), the drive falls back to `contentIndex.refresh` directly.
   */
  refreshStatic?: (projectId: string) => Promise<unknown>;
}

/**
 * On-demand drive intensity:
 *   - `background` — start now (skip the idle wait) but stay polite: ambient
 *     one-shots that the local engine holds behind live chat, day-size
 *     batches.
 *   - `full` — occupy the engine: non-ambient one-shots that compete like any
 *     interactive work, night-size batches, run to drain without yielding.
 * Both honor the indexing job's pause switch between batches.
 */
export type DriveIntensity = 'background' | 'full';

export interface DriveOptions {
  intensity: DriveIntensity;
  /** Run the review tier after summaries drain (default true). */
  reviews?: boolean;
}

export class IndexEnrichmentManager {
  private readonly store: Store;
  private readonly chat: ChatManager;
  private readonly contentIndex: ContentIndex;
  private readonly idle: SystemIdleState;
  private readonly intervalMs: number;
  private readonly startupDelayMs: number;
  private readonly osIdleThresholdMs: number;
  private readonly isNightShiftActive: () => boolean;
  private readonly isPaused: () => Promise<boolean> | boolean;
  private readonly events: Pick<ChatEventBus, 'publishGlobalEvent'> | undefined;
  private readonly resolveBoekwachter: (projectId: string) => Promise<GezelDetail | null>;
  private readonly shadowProducers: AiShadowProducers | undefined;
  private readonly history: IndexEnrichmentManagerOptions['history'];
  private readonly refreshStatic: ((projectId: string) => Promise<unknown>) | undefined;
  /** In-flight on-demand drives, one per project (joiners get the same run). */
  private readonly drives = new Map<string, { mode: DriveIntensity; run: Promise<void> }>();
  /** Nonzero while a night-shift catch-up sweep is holding task dispatch. */
  private catchUpRuns = 0;

  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private activity: IndexEnrichmentActivity | null = null;

  constructor(opts: IndexEnrichmentManagerOptions) {
    this.store = opts.store;
    this.chat = opts.chat;
    this.contentIndex = opts.contentIndex;
    this.idle = opts.idle;
    this.intervalMs = opts.intervalMs ?? TICK_INTERVAL_MS;
    this.startupDelayMs = opts.startupDelayMs ?? STARTUP_DELAY_MS;
    this.osIdleThresholdMs = opts.osIdleThresholdMs ?? OS_IDLE_THRESHOLD_MS;
    this.isNightShiftActive = opts.isNightShiftActive ?? (() => false);
    this.isPaused = opts.isPaused ?? (() => false);
    this.events = opts.events;
    this.resolveBoekwachter =
      opts.resolveBoekwachter ??
      ((projectId) => resolveProjectBoekwachter(this.store, projectId).catch(() => null));
    this.shadowProducers = opts.shadowProducers;
    this.history = opts.history;
    this.refreshStatic = opts.refreshStatic;
  }

  start(): void {
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      void this.tick().catch((err) => log.warn(`[enrich] startup tick failed: ${describe(err)}`));
    }, this.startupDelayMs);
    unref(this.startupTimer);
    this.tickTimer = setInterval(() => {
      void this.tick().catch((err) => log.warn(`[enrich] tick failed: ${describe(err)}`));
    }, this.intervalMs);
    unref(this.tickTimer);
  }

  stop(): void {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.startupTimer = null;
    this.tickTimer = null;
  }

  /** Live, durable-for-the-tick status consumed by the Night Shift menu. */
  getActivity(): IndexEnrichmentActivity | null {
    return this.activity ? { ...this.activity } : null;
  }

  /**
   * Emit the once-per-wave `project.index.reviewed` audit event: only on the
   * transition where this tick stored reviews AND the queue is now empty.
   * Per-file events would flood the ~150-kind flat log (day batches alone
   * would emit dozens per sweep); the drain is the meaningful moment.
   */
  private async logReviewDrain(
    projectId: string,
    boekwachter: GezelDetail,
    deps: EnrichDeps,
    storedThisTick: number,
  ): Promise<void> {
    if (!this.history || storedThisTick === 0) return;
    const counts = await this.contentIndex.reviewCounts(projectId).catch(() => null);
    if (!counts || counts.pending > 0) return;
    const issues = await this.contentIndex.listFileIssues(projectId, {}).catch(() => null);
    await this.history
      .log({
        kind: 'project.index.reviewed',
        projectId,
        gezelId: boekwachter.id,
        summary: `${boekwachter.name} finished reviewing ${counts.reviewed} workspace files`,
        details: {
          files: counts.reviewed,
          ...(issues ? { issues: issues.counts.total } : {}),
          ...(deps.model ? { model: deps.model } : {}),
        },
      })
      .catch(() => {});
  }

  /**
   * True while a night-shift catch-up sweep runs — the TaskRunner holds
   * night-shift task dispatch on it so batch work starts against a current
   * index, per the explicit "index first, then tasks" activation contract.
   */
  isCatchUpActive(): boolean {
    return this.catchUpRuns > 0;
  }

  /** True while an on-demand drive is running (optionally for one project). */
  isDriving(projectId?: string): boolean {
    return projectId ? this.drives.has(projectId) : this.drives.size > 0;
  }

  /** Mode of the drive running for a project, or null when idle. */
  driveMode(projectId: string): DriveIntensity | null {
    return this.drives.get(projectId)?.mode ?? null;
  }

  /**
   * Start an on-demand drive for one project: static refresh first, then the
   * AI tiers (shadows → summaries → areas → reviews) to drain. Returns
   * immediately; progress flows over the usual `index_progress` events and
   * `/index/status` polling. One drive per project — a second request joins
   * the running one.
   */
  drive(projectId: string, opts: DriveOptions): { started: boolean; alreadyRunning: boolean } {
    if (this.drives.has(projectId)) return { started: false, alreadyRunning: true };
    const run = this.runDrive(projectId, opts)
      .catch((err) => log.warn(`[enrich] drive ${projectId} failed: ${describe(err)}`))
      .finally(() => this.drives.delete(projectId));
    this.drives.set(projectId, { mode: opts.intensity, run });
    return { started: true, alreadyRunning: false };
  }

  /**
   * Bring every indexing-enabled project's static AND AI index up to date,
   * sequentially at full intensity — the night-shift activation sweep. The
   * catch-up flag is raised synchronously so a caller that kicks this (not
   * awaited) and then wakes the TaskRunner still gets the dispatch hold.
   */
  async catchUpAll(): Promise<void> {
    this.catchUpRuns++;
    try {
      const projects = await this.store.listProjects().catch(() => []);
      for (const p of projects) {
        if (p.indexingEnabled === false) continue;
        const existing = this.drives.get(p.id);
        if (existing) {
          await existing.run.catch(() => {});
          continue;
        }
        const run = this.runDrive(p.id, { intensity: 'full' }).finally(() =>
          this.drives.delete(p.id),
        );
        this.drives.set(p.id, { mode: 'full', run });
        await run.catch((err) => log.warn(`[enrich] catch-up ${p.id} failed: ${describe(err)}`));
      }
    } finally {
      this.catchUpRuns--;
    }
  }

  private async isSharedLibrary(projectId: string): Promise<boolean> {
    // Guarded rather than optional-chained on the call alone: a store that
    // does not expose `getProject` (narrow test doubles) would otherwise
    // throw synchronously here and take the whole drive down with it.
    if (typeof this.store.getProject !== 'function') return false;
    const meta = await this.store.getProject(projectId).catch(() => null);
    return meta ? isSharedLibraryProject(meta) : false;
  }

  private async runDrive(projectId: string, opts: DriveOptions): Promise<void> {
    const full = opts.intensity === 'full';
    // The review tier judges files against code-shaped rubrics (structure,
    // dead code, test coverage). Pointed at a policy document or a style
    // guide it produces confident nonsense, so the library gets the tiers
    // that transfer — media shadows, summaries, embeddings — and not this
    // one. Forced here rather than at the call sites so every path (idle
    // tick, night shift, manual drive) inherits it.
    const libraryScope = await this.isSharedLibrary(projectId);
    const reviews = opts.reviews !== false && !libraryScope;
    if (await this.isPaused()) return;
    if (!(await this.store.projectIndexingEnabled(projectId).catch(() => true))) return;
    const label = (state: 'started' | 'ended', detail: string) =>
      this.events?.publishGlobalEvent({
        type: 'index_progress',
        phase: 'scan',
        state,
        projectId,
        detail,
      });
    label('started', full ? 'Full index catch-up' : 'Index catch-up');
    try {
      // (a) static first — every AI tier below must see current files. The
      // structural refresh drives ContentIndex.refresh itself; the direct
      // call is the test-seam fallback.
      if (this.refreshStatic) await this.refreshStatic(projectId).catch(() => {});
      else await this.contentIndex.refresh(projectId).catch(() => {});

      // (b) always-on embed-only tier, drained BEFORE the roster gate: the
      // embedder is local and LLM-free, so semantic search needs no
      // Boekwachter — a drive on an unstaffed project still delivers it.
      // The full enrichment below supersedes this work where a roster exists.
      if (!embeddingsDisabledReason()) {
        for (;;) {
          if (await this.isPaused()) return;
          const r = await this.contentIndex
            .embedOnly(projectId, full ? NIGHT_BATCH : EMBED_ONLY_BATCH)
            .catch(() => null);
          if (!r || r.files === 0) break;
          if (r.embedded > 0) {
            log.info(`[enrich] ${projectId}: ${r.embedded} files embed-only (semantic search)`);
          }
          if (r.embedded === 0) break; // embeddings unavailable — don't spin
        }
      }

      const boekwachter = await this.resolveBoekwachter(projectId);
      if (!boekwachter) return; // static is current; AI needs the roster opt-in
      const deps = await buildEnrichDeps(this.store, this.chat, {
        nightShift: this.isNightShiftActive(),
        // Full-bore competes like interactive work; background stays ambient
        // so the local engine holds it behind live chat.
        ambient: !full,
        boekwachter,
        projectId,
      });
      const gezel = { gezelId: boekwachter.id, gezelName: boekwachter.name };
      const batch = full ? NIGHT_BATCH : BATCH;
      // Full-bore fills the target's queue: dispatch width-many per-file
      // scans at once (the live queue concurrency — 4 on a codex-style CLI
      // pool, the batch width on a local engine) and drain-refill so the
      // pool stays full instead of tapering to zero at each batch tail.
      // Pause and progress keep their per-batch cadence via the drain
      // callbacks. Background stays serial; the media tier below stays
      // serial too — its producers are the local vision/STT stacks, not
      // the summarizer target this width describes.
      const drivePool = full && deps.oneShotWidth ? { concurrency: deps.oneShotWidth } : undefined;
      const driveOpts = (phase: 'enrich' | 'review') =>
        drivePool
          ? {
              ...drivePool,
              drain: {
                shouldStop: () => this.isPaused(),
                onProgress: ({ files }: { files: number }) =>
                  this.events?.publishGlobalEvent({
                    type: 'index_progress',
                    phase,
                    state: 'progress',
                    projectId,
                    detail: `${files} files ${phase === 'enrich' ? 'enriched' : 'reviewed'}`,
                    ...gezel,
                  }),
              },
            }
          : undefined;
      const rubrics: Map<string, ResolvedRubric> =
        deps.model && reviews
          ? await resolveRubrics(this.store).catch(() => new Map<string, ResolvedRubric>())
          : new Map<string, ResolvedRubric>();

      if (this.shadowProducers) {
        for (;;) {
          if (await this.isPaused()) return;
          const sh = await this.contentIndex
            .aiShadows(
              projectId,
              {
                ...this.shadowProducers,
                ...(deps.provenance ? { provenance: deps.provenance } : {}),
              },
              batch,
            )
            .catch(() => null);
          if (!sh || sh.files === 0) break;
          this.events?.publishGlobalEvent({
            type: 'index_progress',
            phase: 'shadow',
            state: 'progress',
            projectId,
            detail: `${sh.produced} media files described`,
            ...gezel,
          });
        }
      }
      for (;;) {
        if (await this.isPaused()) return;
        const r = await this.contentIndex
          .enrich(projectId, deps, batch, driveOpts('enrich'))
          .catch(() => null);
        if (!r || r.files === 0) break;
        this.events?.publishGlobalEvent({
          type: 'index_progress',
          phase: 'enrich',
          state: 'progress',
          projectId,
          detail: `${r.files} files enriched`,
          ...gezel,
        });
      }
      await this.contentIndex.enrichAreas(projectId, deps).catch(() => null);
      if (rubrics.size > 0) {
        let stored = 0;
        for (;;) {
          if (await this.isPaused()) return;
          const r = await this.contentIndex
            .review(projectId, deps, batch, rubrics, driveOpts('review'))
            .catch(() => null);
          stored += r?.reviewed ?? 0;
          if (!r || r.files === 0) break;
          this.events?.publishGlobalEvent({
            type: 'index_progress',
            phase: 'review',
            state: 'progress',
            projectId,
            detail: `${r.files} files reviewed`,
            ...gezel,
          });
        }
        await this.logReviewDrain(projectId, boekwachter, deps, stored);
      }
      log.info(`[enrich] ${projectId}: ${opts.intensity} drive complete`);
    } finally {
      label('ended', full ? 'Full index catch-up finished' : 'Index catch-up finished');
    }
  }

  /** Exposed for tests: run one batch ignoring the timers (still idle-gated). */
  async tick(): Promise<void> {
    if (this.running) return;
    // An on-demand drive is already the bulk consumer of the engine — the
    // background loop stands down until it finishes.
    if (this.drives.size > 0) return;
    if (await this.isPaused()) return;
    if (!this.isIdle()) return;
    this.running = true;
    this.activity = {
      id: 'index-enrichment',
      title: 'Workspace indexing',
      detail: 'Checking projects for new files',
    };
    try {
      const night = this.isNightShiftActive();
      const batch = night ? NIGHT_BATCH : BATCH;
      const deadline = night ? Date.now() + NIGHT_TICK_BUDGET_MS : null;
      const projects = await this.store.listProjects().catch(() => []);
      let didWork = false;
      for (const p of projects) {
        // `indexingEnabled: false` is a full workspace-index opt-out, not
        // merely a request to skip the cheap structural pass. Do not consume
        // an older on-disk index if the project was disabled after a scan.
        if (p.indexingEnabled === false) continue;
        if (this.chat.isProjectActive(p.id)) continue;
        // Always-on embed-only tier, ahead of the roster gate: the embedder
        // is local and LLM-free, so every indexing-enabled project gets
        // semantic search — recruiting a Boekwachter upgrades it with
        // summaries/reviews/media rather than gating it.
        if (!embeddingsDisabledReason()) {
          const embedded = await this.contentIndex
            .embedOnly(p.id, night ? NIGHT_BATCH : EMBED_ONLY_BATCH)
            .catch(() => null);
          if (embedded && embedded.embedded > 0) {
            didWork = true;
            log.info(`[enrich] ${p.id}: ${embedded.embedded} files embed-only (semantic search)`);
            this.events?.publishGlobalEvent({
              type: 'index_progress',
              phase: 'enrich',
              state: 'progress',
              projectId: p.id,
              detail: `${embedded.embedded} files embedded for search`,
            });
          }
        }
        // Roster presence is the explicit opt-in for AI indexing (summaries,
        // reviews, media). The cheap WorkspaceIndexManager scan and the
        // embed-only tier above run independently for every project.
        const boekwachter = await this.resolveBoekwachter(p.id);
        if (!boekwachter) continue;
        this.activity = {
          id: 'index-enrichment',
          title: 'Workspace indexing',
          detail: 'Studying workspace files',
          projectId: p.id,
          ...(p.name ? { projectName: p.name } : {}),
        };
        const deps = await this.buildDeps(night, boekwachter, p.id);
        const rubrics: Map<string, ResolvedRubric> = deps.model
          ? await resolveRubrics(this.store).catch(() => new Map<string, ResolvedRubric>())
          : new Map<string, ResolvedRubric>();
        // AI-shadow tier first: a produced description/transcript immediately
        // joins the enrichment work-list below, so one tick can take an image
        // from "filename only" to summarized + embedded. Small batches —
        // vision + STT calls are heavy.
        if (this.shadowProducers) {
          this.activity = {
            id: 'index-enrichment',
            title: 'Workspace indexing',
            detail: 'Describing images and transcribing audio',
            projectId: p.id,
            ...(p.name ? { projectName: p.name } : {}),
          };
          const sh = await this.contentIndex
            .aiShadows(
              p.id,
              {
                ...this.shadowProducers,
                ...(deps.provenance ? { provenance: deps.provenance } : {}),
              },
              night ? 5 : 2,
            )
            .catch(() => null);
          if (sh && sh.produced > 0) {
            didWork = true;
            log.info(`[enrich] ${p.id}: ${sh.produced} shadow files (${sh.called} model calls)`);
            this.events?.publishGlobalEvent({
              type: 'index_progress',
              phase: 'shadow',
              state: 'progress',
              projectId: p.id,
              detail: `${sh.produced} media files described`,
              gezelId: boekwachter.id,
              gezelName: boekwachter.name,
            });
          }
        }
        let drained = false;
        for (;;) {
          if (this.chat.isAnyActive()) return; // yield to live work immediately
          const r = await this.contentIndex.enrich(p.id, deps, batch).catch(() => null);
          const files = r?.files ?? 0;
          if (files > 0) {
            didWork = true;
            log.info(
              `[enrich] ${p.id}: ${files} files, ${r!.summarized} summaries, ${r!.embedded} vectors`,
            );
            this.events?.publishGlobalEvent({
              type: 'index_progress',
              phase: 'enrich',
              state: 'progress',
              projectId: p.id,
              detail: `${files} files enriched`,
              gezelId: boekwachter.id,
              gezelName: boekwachter.name,
            });
          }
          if (files === 0) {
            drained = r !== null;
            break;
          }
          if (!night) break; // day: one batch per project per tick
          if (deadline && Date.now() >= deadline) return;
        }
        if (drained) {
          // File tier done for this project → hash-gated deep pass (folder +
          // architecture rollups). Costs nothing when nothing changed.
          this.activity = {
            id: 'index-enrichment',
            title: 'Workspace indexing',
            detail: 'Updating the project map',
            projectId: p.id,
            ...(p.name ? { projectName: p.name } : {}),
          };
          const areas = await this.contentIndex.enrichAreas(p.id, deps).catch(() => null);
          if (areas && (areas.areasUpdated > 0 || areas.architectureUpdated)) {
            didWork = true;
            log.info(
              `[enrich] ${p.id}: ${areas.areasUpdated} area summaries${areas.architectureUpdated ? ' + architecture note' : ''}`,
            );
            this.events?.publishGlobalEvent({
              type: 'index_progress',
              phase: 'enrich',
              state: 'ended',
              projectId: p.id,
              detail: `${areas.areasUpdated} folder summaries${areas.architectureUpdated ? ' + architecture note' : ''}`,
              gezelId: boekwachter.id,
              gezelName: boekwachter.name,
            });
          }
          // Review tier — strictly behind summaries + areas: the summary/
          // embedding pipeline feeds search coverage (the benchmarked metric)
          // and must never wait behind reviews.
          if (rubrics.size > 0) {
            this.activity = {
              id: 'index-enrichment',
              title: 'Workspace indexing',
              detail: 'Reviewing indexed files',
              projectId: p.id,
              ...(p.name ? { projectName: p.name } : {}),
            };
            let storedThisTick = 0;
            for (;;) {
              if (this.chat.isAnyActive()) return; // yield to live work immediately
              const r = await this.contentIndex
                .review(p.id, deps, batch, rubrics)
                .catch(() => null);
              const files = r?.files ?? 0;
              storedThisTick += r?.reviewed ?? 0;
              if (files > 0) {
                didWork = true;
                log.info(`[enrich] ${p.id}: ${files} files reviewed (${r!.reviewed} stored)`);
                this.events?.publishGlobalEvent({
                  type: 'index_progress',
                  phase: 'review',
                  state: 'progress',
                  projectId: p.id,
                  detail: `${files} files reviewed`,
                  gezelId: boekwachter.id,
                  gezelName: boekwachter.name,
                });
              }
              if (files === 0) break;
              if (!night) break; // day: one review batch per project per tick
              if (deadline && Date.now() >= deadline) return;
            }
            await this.logReviewDrain(p.id, boekwachter, deps, storedThisTick);
          }
        }
        if (!night && didWork) return; // day: one project's worth of work per tick
        if (deadline && Date.now() >= deadline) return;
      }
    } finally {
      this.activity = null;
      this.running = false;
    }
  }

  private isIdle(): boolean {
    if (this.chat.isAnyActive()) return false;
    // Night Shift is the explicit "do background work now" signal — skip the
    // OS-idle threshold so enrichment runs through the window without
    // waiting for the user to step away from the keyboard.
    if (this.isNightShiftActive()) return true;
    // A daemon that has never heard an idle report and only just booted is
    // NOT evidence of an away user — it is what login, install, and update
    // look like from a headless machine service. Enrichment one-shots
    // cold-load local models, so firing them in that window put a
    // multi-GB engine on the machine while the user was actively setting
    // it up. Wait out the grace; a genuinely headless always-on daemon
    // still gets its enrichment once the grace lapses.
    if (this.idle.unreportedBootGraceActive()) return false;
    const os = this.idle.osIdleSeconds();
    if (os !== null && os * 1000 < this.osIdleThresholdMs) return false;
    return true;
  }

  /** Resolve the configured summarizer (if any) + the always-local embedder. */
  private async buildDeps(
    nightShift: boolean,
    boekwachter: GezelDetail,
    projectId: string,
  ): Promise<EnrichDeps> {
    return buildEnrichDeps(this.store, this.chat, {
      nightShift,
      ambient: true,
      boekwachter,
      projectId,
    });
  }
}

function unref(timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>): void {
  if (typeof (timer as { unref?: () => void }).unref === 'function') {
    (timer as { unref: () => void }).unref();
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
