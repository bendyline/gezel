/**
 * Generic background sync scheduler for connectors. A boekwachter-style loop
 * (modeled on IndexEnrichmentManager, extracted from MailSyncManager): idle-
 * gated, one project per tick, never fighting a live chat turn, dormant unless
 * the security posture permits it. The source-specific bits — which bindings a
 * project carries, the posture gate, and how to sync — are injected via a
 * {@link ConnectorSyncSource}, so mail (and any future connector) share one loop.
 */

import { createLogger, resolveSecurityPolicy } from '@bendyline/gezel';
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

type ProjectListItem = Awaited<ReturnType<Store['listProjects']>>[number];

type Policy = ReturnType<typeof resolveSecurityPolicy>;

/** The source-specific behavior the generic loop delegates to. */
export interface ConnectorSyncSource {
  /** Short tag for logs (`mail`, `connectors`). */
  readonly label: string;
  /**
   * The bindings on a project the loop may sync under `policy` — their
   * `lastSyncedAt` drives due/staleness. A binding the policy holds back must
   * not be listed, or a project would look due on every tick and starve the
   * others.
   */
  listBindings(
    project: ProjectListItem,
    policy: Policy,
  ): { lastSyncedAt?: string }[] | Promise<{ lastSyncedAt?: string }[]>;
  /** Whether the loop runs at all under this policy. */
  posture(policy: Policy): boolean;
  /** Sync one project's eligible bindings; returns per-binding written/quarantined counts. */
  syncProject(
    project: ProjectDetail,
    policy: Policy,
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

  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

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
    this.startupTimer = null;
    this.tickTimer = null;
  }

  /** Exposed for tests: run one sync unit, still idle- + posture-gated. */
  async tick(): Promise<void> {
    if (this.running) return;
    if (!this.isIdle()) return;
    this.running = true;
    try {
      const cfg = await this.store.readConfig().catch(() => null);
      const policy = resolveSecurityPolicy(cfg ?? {});
      // Autonomous sync rides the source's posture gate.
      if (!this.source.posture(policy)) return;

      const projects = await this.store.listProjects().catch(() => []);
      const now = Date.now();
      const candidates: { project: ProjectListItem; last: number }[] = [];
      for (const p of projects) {
        if (this.chat.isProjectActive(p.id)) continue;
        const bindings = await Promise.resolve(this.source.listBindings(p, policy)).catch(() => []);
        if (bindings.length === 0 || !this.isDue(bindings, now)) continue;
        candidates.push({ project: p, last: this.lastSync(bindings) });
      }
      candidates.sort((a, b) => a.last - b.last);

      const target = candidates[0]?.project;
      if (!target) return;
      const full = await this.store.getProject(target.id).catch(() => null);
      if (!full) return;
      const results = await this.source.syncProject(full, policy);
      const wrote = results.reduce((n, r) => n + r.written + r.quarantined, 0);
      if (wrote > 0) {
        log.info(
          `[${this.source.label}-sync] ${target.id}: ${wrote} new record(s) across ${results.length} binding(s)`,
        );
      }
    } finally {
      this.running = false;
    }
  }

  /** Most-recent successful sync across a project's eligible bindings (0 if never). */
  private lastSync(bindings: { lastSyncedAt?: string }[]): number {
    const times = bindings.map((a) => (a.lastSyncedAt ? Date.parse(a.lastSyncedAt) : 0));
    return times.length ? Math.max(...times) : 0;
  }

  private isDue(bindings: { lastSyncedAt?: string }[], now: number): boolean {
    // Due if any binding has never synced, or the freshest sync is stale.
    if (bindings.some((a) => !a.lastSyncedAt)) return true;
    return now - this.lastSync(bindings) >= this.syncIntervalMs;
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

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
