/**
 * Keeps projects on the current version of their app. Plans and applies app
 * updates (`upgrade.ts`) for the routes, and sweeps every project after boot
 * and whenever catalog content changes, applying the updates that need no one.
 *
 * Only Gilde content (`bundled`) updates on its own. An installed AI App can
 * be added by a model (`import_ai_app`), so its updates always wait for the
 * person's click. A project with a turn running waits until it is idle,
 * because the update swaps scripts a turn may be calling.
 */
import {
  type AppliedProjectType,
  type ProjectTypeUpgradePlan,
  createLogger,
} from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import type { ChatEventBus } from '../chat/events.js';
import type { Store } from '../fs/store.js';
import type { HistoryManager } from '../history/manager.js';
import {
  AUTOMATIC_UPDATE_SOURCE,
  applyProjectTypeUpdate,
  automaticUpdatesHeld,
  planProjectTypeUpgrade,
} from './upgrade.js';

const log = createLogger('project-type');

const RETRY_MS = 60_000;

/** The offer the person saw has moved on (a newer version, or none now). */
export class StaleProjectTypeUpgradeError extends Error {
  readonly code = 'stale_upgrade' as const;
  constructor(readonly current: ProjectTypeUpgradePlan | null) {
    super(
      current
        ? `The update on offer is now version ${current.toVersion}.`
        : 'This project already runs the newest version of its app.',
    );
    this.name = 'StaleProjectTypeUpgradeError';
  }
}

export interface ProjectTypeUpgraderOptions {
  store: Store;
  catalog: CatalogService;
  home: string;
  history?: Pick<HistoryManager, 'log'>;
  chatEvents?: Pick<ChatEventBus, 'publishProjectEvent'>;
  /** A turn is running or queued in the project. */
  isProjectBusy?: (projectId: string) => boolean;
  /** Rebuild the project's sessions so they pick up the new tool list. */
  resetProjectSessions?: (projectId: string) => Promise<void>;
  /** `GEZEL_DISABLE_PROJECT_TYPE_UPGRADES=1`: no automatic updates (evals). */
  automaticUpdates?: boolean;
  retryMs?: number;
}

export class ProjectTypeUpgrader {
  private readonly opts: ProjectTypeUpgraderOptions;
  private readonly waiting = new Set<string>();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private rerun = false;
  private stopped = false;

  constructor(opts: ProjectTypeUpgraderOptions) {
    this.opts = opts;
  }

  private get deps() {
    return { store: this.opts.store, catalog: this.opts.catalog, home: this.opts.home };
  }

  /** The update this project could take now, or null. */
  plan(projectId: string): Promise<ProjectTypeUpgradePlan | null> {
    return planProjectTypeUpgrade(this.deps, projectId);
  }

  /**
   * Apply the update the person approved. Refused with
   * `StaleProjectTypeUpgradeError` when the offer is no longer `toVersion`.
   */
  async upgrade(projectId: string, toVersion: string): Promise<AppliedProjectType> {
    const current = await this.plan(projectId);
    if (!current || current.toVersion !== toVersion) {
      throw new StaleProjectTypeUpgradeError(current);
    }
    const applied = await applyProjectTypeUpdate(this.deps, {
      projectId,
      version: toVersion,
      personApproved: true,
    });
    this.waiting.delete(projectId);
    await this.announce(projectId, current.typeName, applied, false);
    return applied;
  }

  /**
   * After any apply that moved a project to another version: rebuild its
   * sessions, tell open views, and record it in the project's history.
   */
  async announce(
    projectId: string,
    typeName: string,
    applied: Pick<AppliedProjectType, 'typeId' | 'version' | 'upgradedFrom'>,
    automatic: boolean,
  ): Promise<void> {
    if (!applied.upgradedFrom) return;
    await this.opts.resetProjectSessions?.(projectId).catch((err) => {
      log.warn(`[upgrade] ${projectId}: session reset failed: ${describe(err)}`);
    });
    this.opts.chatEvents?.publishProjectEvent(projectId, {
      type: 'project_updated',
      projectId,
      reason: 'project-type',
    });
    await this.opts.history
      ?.log({
        kind: 'project.type.updated',
        projectId,
        summary: `Updated ${typeName} to version ${applied.version}`,
        details: {
          typeId: applied.typeId,
          typeName,
          fromVersion: applied.upgradedFrom,
          toVersion: applied.version,
          automatic,
        },
      })
      .catch((err) => log.warn(`[upgrade] ${projectId}: history write failed: ${describe(err)}`));
  }

  /** Ask for a sweep; several requests while one runs fold into one more pass. */
  requestSweep(reason: string): void {
    if (this.stopped || this.opts.automaticUpdates === false) return;
    if (this.running) {
      this.rerun = true;
      return;
    }
    void this.sweep(reason).catch((err) => log.warn(`[upgrade] sweep failed: ${describe(err)}`));
  }

  /**
   * Apply every update that needs no one. Returns the projects updated and
   * the ones waiting for a running turn to finish.
   */
  async sweep(
    reason: string,
    only?: ReadonlySet<string>,
  ): Promise<{ updated: string[]; waiting: string[] }> {
    if (this.stopped || this.opts.automaticUpdates === false) return { updated: [], waiting: [] };
    if (this.running) {
      this.rerun = true;
      return { updated: [], waiting: [...this.waiting] };
    }
    this.running = true;
    const updated: string[] = [];
    try {
      let scope = only;
      do {
        this.rerun = false;
        updated.push(...(await this.sweepOnce(reason, scope)));
        scope = undefined;
      } while (this.rerun && !this.stopped);
    } finally {
      this.running = false;
    }
    this.armRetry();
    return { updated, waiting: [...this.waiting] };
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private async sweepOnce(reason: string, only?: ReadonlySet<string>): Promise<string[]> {
    const updated: string[] = [];
    const projects = await this.opts.store.listProjects().catch(() => []);
    for (const project of projects) {
      if (this.stopped) break;
      if (only && !only.has(project.id)) continue;
      const type = project.projectType;
      if (!type || type.pinned || type.source !== AUTOMATIC_UPDATE_SOURCE) continue;
      if (automaticUpdatesHeld(project)) continue;
      try {
        const plan = await this.plan(project.id);
        if (!plan) {
          this.waiting.delete(project.id);
          continue;
        }
        if (!plan.automatic) continue;
        if (this.opts.isProjectBusy?.(project.id)) {
          this.waiting.add(project.id);
          continue;
        }
        const applied = await applyProjectTypeUpdate(this.deps, {
          projectId: project.id,
          version: plan.toVersion,
        });
        this.waiting.delete(project.id);
        await this.announce(project.id, plan.typeName, applied, true);
        updated.push(project.id);
      } catch (err) {
        log.warn(`[upgrade] ${project.id}: automatic app update failed: ${describe(err)}`);
      }
    }
    if (updated.length > 0) {
      log.info(`[upgrade] updated ${updated.length} project(s) to newer app versions (${reason})`);
    }
    return updated;
  }

  /** One timer, armed only while a busy project waits for its update. */
  private armRetry(): void {
    if (this.stopped || this.retryTimer || this.waiting.size === 0) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.sweep('retry', new Set(this.waiting)).catch((err) =>
        log.warn(`[upgrade] retry failed: ${describe(err)}`),
      );
    }, this.opts.retryMs ?? RETRY_MS);
    (this.retryTimer as unknown as { unref?: () => void }).unref?.();
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
