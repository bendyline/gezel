/**
 * Generic background sync scheduler for connectors. A boekwachter-style loop
 * (modeled on IndexEnrichmentManager, extracted from MailSyncManager): idle-
 * gated, one project per tick, never fighting a live chat turn, dormant unless
 * the security posture permits it. The source-specific bits — which bindings a
 * project carries, the posture gate, and how to sync — are injected via a
 * {@link ConnectorSyncSource}, so mail (and any future connector) share one loop.
 */

import { createAwakeTimeout, createLogger, resolveSecurityPolicy } from '@bendyline/gezel';
import type { ProjectDetail } from '@bendyline/gezel';
import type { ChatManager } from '../chat/manager.js';
import type { Store } from '../fs/store.js';
import type { SystemIdleState } from '../system/idle-state.js';

const log = createLogger('connectors');

const STARTUP_DELAY_MS = 30_000;
const TICK_INTERVAL_MS = 90_000;
const OS_IDLE_THRESHOLD_MS = 180_000;
/** How stale a binding's last sync must be before the loop re-syncs it. */
const DEFAULT_SYNC_INTERVAL_MS = 5 * 60_000;
/**
 * Awake time one pass may take before later ticks stop waiting for it. The
 * pass keeps running and keeps its project's lock; only the loop moves on.
 */
const DEFAULT_PASS_BUDGET_MS = 30 * 60_000;

type ProjectListItem = Awaited<ReturnType<Store['listProjects']>>[number];

type Policy = ReturnType<typeof resolveSecurityPolicy>;

/** One binding as the loop sees it. */
export interface SyncCandidateBinding {
  id: string;
  lastSyncedAt?: string;
  /** This binding's own interval (its type's `syncIntervalMinutes`), in place of the loop's. */
  intervalMs?: number;
  /**
   * Its passes could not reach the service (offline). It may catch up while
   * the person is at the keyboard: the quiet-machine rule exists to keep
   * routine syncs out of the way, and a connection that has fallen behind
   * because of the network is what someone back online expects to see move.
   */
  waiting?: boolean;
}

/** The source-specific behavior the generic loop delegates to. */
export interface ConnectorSyncSource {
  /** Short tag for logs (`mail`, `connectors`). */
  readonly label: string;
  /**
   * The bindings on a project the loop may sync now under `policy`; their
   * `lastSyncedAt` decides which are due. Leave out any binding the pass
   * would skip (held back by the policy, paused, backing off after a
   * failure): a listed binding that never syncs keeps its project due.
   */
  listBindings(
    project: ProjectListItem,
    policy: Policy,
  ): SyncCandidateBinding[] | Promise<SyncCandidateBinding[]>;
  /** Whether the loop runs at all under this policy. */
  posture(policy: Policy): boolean;
  /**
   * Sync the named bindings on one project (the ones that are due); returns
   * per-binding written/quarantined counts.
   */
  syncProject(
    project: ProjectDetail,
    policy: Policy,
    bindingIds: readonly string[],
  ): Promise<Array<{ written: number; quarantined: number }>>;
}

export interface ConnectorSyncManagerOptions {
  store: Store;
  chat: ChatManager;
  idle: SystemIdleState;
  source: ConnectorSyncSource;
  isNightShiftActive?: () => boolean;
  intervalMs?: number;
  startupDelayMs?: number;
  osIdleThresholdMs?: number;
  syncIntervalMs?: number;
  /** Awake time to wait for one pass before later ticks go on without it. */
  passBudgetMs?: number;
}

export class ConnectorSyncManager {
  protected readonly store: Store;
  protected readonly chat: ChatManager;
  protected readonly idle: SystemIdleState;
  protected readonly source: ConnectorSyncSource;
  protected readonly isNightShiftActive: () => boolean;
  private readonly intervalMs: number;
  private readonly startupDelayMs: number;
  private readonly osIdleThresholdMs: number;
  private readonly syncIntervalMs: number;
  private readonly passBudgetMs: number;

  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private soonTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  /**
   * When the loop last started a pass for each project. Ordering by attempt,
   * not by success, is what keeps one project whose sync keeps failing or
   * being skipped from being picked on every tick.
   */
  private readonly lastAttempt = new Map<string, number>();
  /** Projects whose pass outlived the budget and has not settled yet. */
  private readonly inFlight = new Set<string>();

  constructor(opts: ConnectorSyncManagerOptions) {
    this.store = opts.store;
    this.chat = opts.chat;
    this.idle = opts.idle;
    this.source = opts.source;
    this.isNightShiftActive = opts.isNightShiftActive ?? (() => false);
    this.intervalMs = opts.intervalMs ?? TICK_INTERVAL_MS;
    this.startupDelayMs = opts.startupDelayMs ?? STARTUP_DELAY_MS;
    this.osIdleThresholdMs = opts.osIdleThresholdMs ?? OS_IDLE_THRESHOLD_MS;
    this.syncIntervalMs = opts.syncIntervalMs ?? DEFAULT_SYNC_INTERVAL_MS;
    this.passBudgetMs = opts.passBudgetMs ?? DEFAULT_PASS_BUDGET_MS;
  }

  start(): void {
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      void this.tick().catch((err) =>
        log.warn(`[${this.source.label}-sync] startup tick failed: ${describe(err)}`),
      );
    }, this.startupDelayMs);
    unref(this.startupTimer);
    this.tickTimer = setInterval(() => {
      void this.tick().catch((err) =>
        log.warn(`[${this.source.label}-sync] tick failed: ${describe(err)}`),
      );
    }, this.intervalMs);
    unref(this.tickTimer);
  }

  stop(): void {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.soonTimer) clearTimeout(this.soonTimer);
    this.startupTimer = null;
    this.tickTimer = null;
    this.soonTimer = null;
  }

  /**
   * Tick shortly instead of at the next interval: the network just came back
   * and connections waiting for it should catch up now. The few seconds let
   * a new network finish handing out addresses and resolvers.
   */
  tickSoon(delayMs = 5_000): void {
    if (this.soonTimer || !this.tickTimer) return;
    this.soonTimer = setTimeout(() => {
      this.soonTimer = null;
      void this.tick().catch((err) =>
        log.warn(`[${this.source.label}-sync] tick failed: ${describe(err)}`),
      );
    }, delayMs);
    unref(this.soonTimer);
  }

  /**
   * Exposed for tests: run one sync unit, still posture-gated. Never during a
   * chat turn; when the person is at the keyboard, only connections waiting
   * for the network are picked.
   */
  async tick(): Promise<void> {
    if (this.running) return;
    if (this.chat.isAnyActive()) return;
    const quiet = this.isIdle();
    this.running = true;
    try {
      const cfg = await this.store.readConfig().catch(() => null);
      const policy = resolveSecurityPolicy(cfg ?? {});
      // Autonomous sync rides the source's posture gate.
      if (!this.source.posture(policy)) return;

      const projects = await this.store.listProjects().catch(() => []);
      const now = Date.now();
      const candidates: {
        project: ProjectListItem;
        due: string[];
        attempted: number;
        oldestSync: number;
      }[] = [];
      for (const p of projects) {
        if (this.inFlight.has(p.id) || this.chat.isProjectActive(p.id)) continue;
        const bindings = await Promise.resolve(this.source.listBindings(p, policy)).catch(() => []);
        const due = bindings.filter((b) => (quiet || b.waiting) && this.isDue(b, now));
        if (due.length === 0) continue;
        candidates.push({
          project: p,
          due: due.map((b) => b.id),
          attempted: this.lastAttempt.get(p.id) ?? 0,
          oldestSync: Math.min(...due.map(syncedAt)),
        });
      }
      candidates.sort((a, b) => a.attempted - b.attempted || a.oldestSync - b.oldestSync);

      const pick = candidates[0];
      if (!pick) return;
      const full = await this.store.getProject(pick.project.id).catch(() => null);
      if (!full) return;
      this.lastAttempt.set(pick.project.id, now);
      await this.runPass(full, policy, pick.due);
    } finally {
      this.running = false;
    }
  }

  /**
   * Run one project's pass, waiting at most the pass budget in awake time. A
   * pass that outlives it keeps running; its project is skipped until it
   * settles, and the loop goes on with the others.
   */
  private async runPass(project: ProjectDetail, policy: Policy, bindingIds: string[]) {
    this.inFlight.add(project.id);
    const settled = this.source.syncProject(project, policy, bindingIds).then(
      (results) => ({ ok: true as const, results }),
      (err: unknown) => ({ ok: false as const, err }),
    );
    void settled.finally(() => this.inFlight.delete(project.id));
    const watchdog = createAwakeTimeout(this.passBudgetMs);
    try {
      const timedOut = new Promise<'timeout'>((resolve) =>
        watchdog.signal.addEventListener('abort', () => resolve('timeout'), { once: true }),
      );
      const outcome = await Promise.race([settled, timedOut]);
      if (outcome === 'timeout') {
        log.warn(
          `[${this.source.label}-sync] ${project.id}: pass still running after ` +
            `${Math.round(this.passBudgetMs / 60_000)} min; other projects sync without it`,
        );
        return;
      }
      if (!outcome.ok) throw outcome.err;
      const wrote = outcome.results.reduce((n, r) => n + r.written + r.quarantined, 0);
      if (wrote > 0) {
        log.info(
          `[${this.source.label}-sync] ${project.id}: ${wrote} new record(s) across ${outcome.results.length} binding(s)`,
        );
      }
    } finally {
      watchdog.dispose();
    }
  }

  /** A binding is due when it has never synced or its last sync is stale. */
  private isDue(binding: SyncCandidateBinding, now: number): boolean {
    return now - syncedAt(binding) >= (binding.intervalMs ?? this.syncIntervalMs);
  }

  private isIdle(): boolean {
    if (this.chat.isAnyActive()) return false;
    if (this.isNightShiftActive()) return true;
    const os = this.idle.osIdleSeconds();
    if (os !== null && os * 1000 < this.osIdleThresholdMs) return false;
    return true;
  }
}

function unref(timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>): void {
  if (typeof (timer as { unref?: () => void }).unref === 'function') {
    (timer as { unref: () => void }).unref();
  }
}

/** Epoch ms of a binding's last successful sync; 0 when it never synced. */
function syncedAt(binding: SyncCandidateBinding): number {
  const ms = binding.lastSyncedAt ? Date.parse(binding.lastSyncedAt) : 0;
  return Number.isFinite(ms) ? ms : 0;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
