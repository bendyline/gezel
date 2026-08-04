import { type GezelDetail, createLogger } from '@bendyline/gezel';
import type { ChatEventBus } from '../chat/events.js';
import type { ChatManager } from '../chat/manager.js';
import type { Store } from '../fs/store.js';
import { resolveProjectBoekwachter } from '../gezels/autonomous-roles.js';
import type { SystemIdleState } from '../system/idle-state.js';
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

  /** Exposed for tests: run one batch ignoring the timers (still idle-gated). */
  async tick(): Promise<void> {
    if (this.running) return;
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
        // Roster presence is the explicit opt-in for AI indexing. The cheap
        // WorkspaceIndexManager scan runs independently for every project.
        const boekwachter = await this.resolveBoekwachter(p.id);
        if (!boekwachter) continue;
        if (this.chat.isProjectActive(p.id)) continue;
        this.activity = {
          id: 'index-enrichment',
          title: 'Workspace indexing',
          detail: 'Studying workspace files',
          projectId: p.id,
          ...(p.name ? { projectName: p.name } : {}),
        };
        const deps = await this.buildDeps(night, boekwachter);
        const rubrics: Map<string, ResolvedRubric> = deps.model
          ? await resolveRubrics(this.store).catch(() => new Map<string, ResolvedRubric>())
          : new Map<string, ResolvedRubric>();
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
            for (;;) {
              if (this.chat.isAnyActive()) return; // yield to live work immediately
              const r = await this.contentIndex
                .review(p.id, deps, batch, rubrics)
                .catch(() => null);
              const files = r?.files ?? 0;
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
  private async buildDeps(nightShift: boolean, boekwachter: GezelDetail): Promise<EnrichDeps> {
    return buildEnrichDeps(this.store, this.chat, {
      nightShift,
      ambient: true,
      boekwachter,
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
