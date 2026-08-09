import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  type GildeUpdateCheckResult,
  GildeUpdateCheckResultSchema,
  type GildeUpdateStatusResponse,
  createLogger,
  flattenErrorMessage,
  resolveSecurityPolicy,
} from '@bendyline/gezel';
import {
  GILDE_PACKAGE_NAME,
  compareRelease,
  fetchGildeReleases,
  gildeDataDir,
  gildePackageRoot,
  isGildeReleaseVersion,
  pickGildePatchUpdate,
  publishStagedNpmInstall,
  stageGildeVersion,
  validateGildeContentUpgrade,
} from '@bendyline/gezel-catalog';
import {
  gildeLiveStateFile,
  gildeLiveVersionDir,
  gildeLiveVersionsDir,
} from '@bendyline/gezel/paths';
import { z } from 'zod';
import { writeFileAtomic } from '../fs/atomic.js';
import type { Store } from '../fs/store.js';
import type { HistoryManager } from '../history/manager.js';

/**
 * Opt-in live gilde content updates. Owns the `~/.gezel/gilde/` carve-out:
 * `versions/<v>/package/` (extracted `@bendyline/gilde` releases) plus
 * `state.json`. The manager decides the effective catalog content root —
 * `CatalogService` is constructed once at boot with a provider closure over
 * `contentDataDir()`, and because catalog reads are fully lazy, flipping the
 * root here is visible to every consumer on their next read.
 *
 * Policy: only patch releases on the bundled pin's minor line are eligible
 * (schema-compatible by construction; line bumps ride app releases), an
 * activation must pass the empirical no-regression gate, and the bundled
 * content is the permanent fallback — boot never blocks on the network and
 * any invalid cached state degrades to bundled, never to a broken catalog.
 */

const log = createLogger('gilde-updates');

const STARTUP_DELAY_MS = 15 * 60_000;
const CHECK_INTERVAL_MS = 24 * 60 * 60_000;
/** Scheduled checks this close to the previous one are skipped (frequent
 * daemon restarts shouldn't turn the startup check into registry noise). */
const MIN_SCHEDULED_GAP_MS = 6 * 60 * 60_000;

const GildeLiveStateSchema = z.object({
  activeVersion: z.string().nullable(),
  integrity: z.string().optional(),
  installedAt: z.string().optional(),
  lastCheck: GildeUpdateCheckResultSchema.optional(),
});
type GildeLiveState = z.infer<typeof GildeLiveStateSchema>;

export type GildeUpdateTrigger = 'scheduled' | 'manual' | 'enabled';

export interface GildeUpdateManagerOptions {
  home: string;
  store: Store;
  history: HistoryManager;
  /** Test/private-registry seam; default registry.npmjs.org. */
  registry?: string;
  /** Test seam; default read from the installed `@bendyline/gilde`. */
  bundledVersion?: string;
  /** Test seam; default `gildeDataDir()` (the installed package's data). */
  bundledDataDir?: string;
  intervalMs?: number;
  startupDelayMs?: number;
  now?: () => Date;
}

export class GildeUpdateManager {
  private readonly home: string;
  private readonly store: Store;
  private readonly history: HistoryManager;
  private readonly registry: string | undefined;
  private readonly intervalMs: number;
  private readonly startupDelayMs: number;
  private readonly now: () => Date;
  private readonly bundledDataDirFn: () => string;
  /** Null when the installed gilde package could not be resolved — live
   * updates stay off rather than comparing against a made-up pin. */
  private readonly bundledVersion: string | null;

  private state: GildeLiveState;
  /** Bumped by `setEnabled(false)`; an in-flight check re-reads it before
   * activating so a disable can never race a publish. */
  private epoch = 0;
  private inFlight: Promise<GildeUpdateStatusResponse> | null = null;
  private readonly contentChangedCallbacks: Array<() => void> = [];
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private checkTimer: ReturnType<typeof setInterval> | null = null;

  private constructor(
    opts: GildeUpdateManagerOptions,
    bundledVersion: string | null,
    state: GildeLiveState,
  ) {
    this.home = opts.home;
    this.store = opts.store;
    this.history = opts.history;
    this.registry = opts.registry;
    this.intervalMs = opts.intervalMs ?? CHECK_INTERVAL_MS;
    this.startupDelayMs = opts.startupDelayMs ?? STARTUP_DELAY_MS;
    this.now = opts.now ?? (() => new Date());
    const fixedBundledDataDir = opts.bundledDataDir;
    this.bundledDataDirFn = fixedBundledDataDir ? () => fixedBundledDataDir : gildeDataDir;
    this.bundledVersion = bundledVersion;
    this.state = state;
  }

  /**
   * Boot resolution — disk only, never the network. Reads and guards
   * `state.json`, sweeps interrupted-install leftovers, and honors a cached
   * live version only when it is still coherent: the extracted package
   * matches the recorded version, sits on the bundled pin's minor line,
   * is strictly newer than the pin, and the opt-in flag is on. Anything
   * less falls back to bundled and prunes the cache.
   */
  static async create(opts: GildeUpdateManagerOptions): Promise<GildeUpdateManager> {
    const bundledVersion = opts.bundledVersion ?? (await readBundledGildeVersion());
    if (!bundledVersion) {
      log.warn(`installed ${GILDE_PACKAGE_NAME} version unresolvable; live updates unavailable`);
    }
    const state = await readState(opts.home);
    const manager = new GildeUpdateManager(opts, bundledVersion, state);
    await manager.sweepLeftovers();
    await manager.validateActiveAtBoot();
    return manager;
  }

  /**
   * The effective gilde content root. Synchronous and cheap — handed to
   * `CatalogService` as its root provider and re-read on every disk access.
   * A `GEZEL_GILDE_DATA_DIR` override keeps absolute priority (dev,
   * `link:gilde`, evals).
   */
  contentDataDir(): string {
    if (envOverride()) return gildeDataDir();
    const active = this.state.activeVersion;
    if (active) return join(gildeLiveVersionDir(this.home, active), 'package', 'data');
    return this.bundledDataDirFn();
  }

  mode(): 'bundled' | 'live' | 'overridden' {
    if (envOverride()) return 'overridden';
    return this.state.activeVersion ? 'live' : 'bundled';
  }

  async status(): Promise<GildeUpdateStatusResponse> {
    const config = await this.store.readConfig().catch(() => null);
    return {
      enabled: config?.gildeUpdates?.enabled === true,
      mode: this.mode(),
      bundledVersion: this.bundledVersion ?? 'unknown',
      activeVersion: this.state.activeVersion,
      lastCheck: this.state.lastCheck ?? null,
      updateInProgress: this.inFlight !== null,
    };
  }

  /** Registration for post-activation cache invalidations (models route
   * TTL cache, craftbook suggestion vectors). Also fired on revert. */
  onContentChanged(cb: () => void): void {
    this.contentChangedCallbacks.push(cb);
  }

  startScheduler(): void {
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      void this.checkNow('scheduled').catch((err) =>
        log.warn(`startup check failed: ${flattenErrorMessage(err)}`),
      );
    }, this.startupDelayMs);
    unref(this.startupTimer);
    this.checkTimer = setInterval(() => {
      void this.checkNow('scheduled').catch((err) =>
        log.warn(`scheduled check failed: ${flattenErrorMessage(err)}`),
      );
    }, this.intervalMs);
    unref(this.checkTimer);
  }

  stop(): void {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.checkTimer) clearInterval(this.checkTimer);
    this.startupTimer = null;
    this.checkTimer = null;
  }

  /**
   * Run one update check. Concurrent callers attach to the in-flight run.
   * Scheduled runs skip silently when gated or recently checked; manual
   * runs record a `blocked` result so the UI can explain itself.
   */
  checkNow(trigger: GildeUpdateTrigger): Promise<GildeUpdateStatusResponse> {
    if (this.inFlight) return this.inFlight;
    const run = (async () => {
      try {
        await this.runCheck(trigger);
      } finally {
        this.inFlight = null;
      }
      return this.status();
    })();
    this.inFlight = run;
    return run;
  }

  /**
   * Applies the opt-in flag. Disabling reverts to bundled content
   * immediately (in-memory flip first, so the next catalog read is already
   * bundled) and prunes the cache; enabling kicks a background check so the
   * toggle gives prompt feedback. Never blocks on the network.
   */
  async setEnabled(enabled: boolean): Promise<void> {
    if (enabled) {
      if (this.mode() !== 'overridden') {
        void this.checkNow('enabled').catch((err) =>
          log.warn(`post-enable check failed: ${flattenErrorMessage(err)}`),
        );
      }
      return;
    }
    this.epoch += 1;
    const wasLive = this.state.activeVersion !== null;
    this.state = {
      ...this.state,
      activeVersion: null,
      integrity: undefined,
      installedAt: undefined,
    };
    await this.writeState();
    await rm(gildeLiveVersionsDir(this.home), { recursive: true, force: true }).catch(() => {});
    if (wasLive) {
      log.info('live gilde content disabled; reverted to bundled');
      this.fireContentChanged();
    }
  }

  private async runCheck(trigger: GildeUpdateTrigger): Promise<void> {
    const startEpoch = this.epoch;
    const scheduled = trigger === 'scheduled';

    const blockReason = await this.blockReason();
    if (blockReason) {
      if (!scheduled) await this.recordCheck({ outcome: 'blocked', message: blockReason });
      return;
    }
    if (scheduled && this.recentlyChecked()) return;

    const bundled = this.bundledVersion;
    if (!bundled) {
      if (!scheduled) {
        await this.recordCheck({
          outcome: 'error',
          message: `installed ${GILDE_PACKAGE_NAME} version unresolvable`,
        });
      }
      return;
    }

    let staging: string | null = null;
    try {
      const releases = await fetchGildeReleases({ registry: this.registry });
      const update = pickGildePatchUpdate(releases, bundled, this.state.activeVersion ?? undefined);
      if (!update) {
        await this.recordCheck({ outcome: 'up-to-date' });
        return;
      }
      log.info(`gilde ${update.version} available (active ${this.state.activeVersion ?? bundled})`);

      const versionsDir = gildeLiveVersionsDir(this.home);
      await mkdir(versionsDir, { recursive: true });
      staging = `${gildeLiveVersionDir(this.home, update.version)}.staging-${process.pid}-${randomUUID()}`;
      const { packageDir } = await stageGildeVersion({
        release: update,
        stagingDir: staging,
        registry: this.registry,
      });

      const validation = await validateGildeContentUpgrade({
        currentDataDir: this.contentDataDir(),
        candidateDataDir: join(packageDir, 'data'),
      });
      if (!validation.ok) {
        await rm(staging, { recursive: true, force: true }).catch(() => {});
        staging = null;
        const sample = validation.regressions
          .slice(0, 3)
          .map((r) => `${r.kind}/${r.id}`)
          .join(', ');
        log.warn(
          `gilde ${update.version} rejected: ${validation.regressions.length} regression(s) (${sample})`,
        );
        await this.recordCheck({
          outcome: 'incompatible',
          version: update.version,
          message: `${validation.regressions.length} item(s) would stop resolving; this update needs a newer app release`,
          regressions: validation.regressions.map((r) => ({ kind: r.kind, id: r.id })),
        });
        return;
      }

      if (this.epoch !== startEpoch) {
        // Disabled while we were downloading/validating — abandon quietly.
        await rm(staging, { recursive: true, force: true }).catch(() => {});
        staging = null;
        return;
      }

      const target = gildeLiveVersionDir(this.home, update.version);
      await publishStagedNpmInstall(staging, target, `${target}.previous`);
      staging = null;

      const previousVersion = this.state.activeVersion ?? bundled;
      this.state = {
        activeVersion: update.version,
        integrity: update.integrity ?? update.shasum,
        installedAt: this.now().toISOString(),
        lastCheck: undefined,
      };
      await this.recordCheck({ outcome: 'updated', version: update.version });
      await this.pruneVersionsExcept(update.version);
      await this.history
        .log({
          kind: 'gilde.updated',
          summary: `Catalog content updated to gilde ${update.version} (was ${previousVersion})`,
          details: { previousVersion, version: update.version, trigger },
        })
        .catch((err) => log.warn(`history write failed: ${flattenErrorMessage(err)}`));
      log.info(`gilde ${update.version} activated (${validation.checked} items validated)`);
      this.fireContentChanged();
    } catch (err) {
      if (staging) await rm(staging, { recursive: true, force: true }).catch(() => {});
      const message = flattenErrorMessage(err);
      log.warn(`gilde update check failed: ${message}`);
      await this.recordCheck({ outcome: 'error', message }).catch(() => {});
    }
  }

  private async blockReason(): Promise<string | null> {
    if (envOverride()) return 'content root is overridden by GEZEL_GILDE_DATA_DIR';
    const config = await this.store.readConfig().catch(() => null);
    if (!config) return 'configuration is unreadable';
    if (config.gildeUpdates?.enabled !== true) return 'live gilde updates are disabled';
    // `allowAppNetwork` is the auto-update capability (same gate as the
    // Electron updater): false only under super-lockdown's "nothing leaves
    // the machine". `allowExternalServices` would be the wrong gate — that
    // governs gezel-facing third-party services and is off at the default
    // lockdown posture, where content updates are meant to work.
    if (!resolveSecurityPolicy(config).allowAppNetwork) {
      return 'auto-update network access is blocked by the security policy';
    }
    return null;
  }

  private recentlyChecked(): boolean {
    const at = this.state.lastCheck?.at;
    if (!at) return false;
    const elapsed = this.now().getTime() - Date.parse(at);
    return Number.isFinite(elapsed) && elapsed >= 0 && elapsed < MIN_SCHEDULED_GAP_MS;
  }

  private async recordCheck(result: Omit<GildeUpdateCheckResult, 'at'>): Promise<void> {
    this.state = { ...this.state, lastCheck: { at: this.now().toISOString(), ...result } };
    await this.writeState();
  }

  private async writeState(): Promise<void> {
    const file = gildeLiveStateFile(this.home);
    await mkdir(dirname(file), { recursive: true });
    await writeFileAtomic(file, `${JSON.stringify(this.state, null, 2)}\n`);
  }

  private fireContentChanged(): void {
    for (const cb of this.contentChangedCallbacks) {
      try {
        cb();
      } catch (err) {
        log.warn(`content-changed callback failed: ${flattenErrorMessage(err)}`);
      }
    }
  }

  /** Interrupted-install leftovers: adopt a completed-but-unrenamed
   * `.previous`, drop orphaned staging dirs. */
  private async sweepLeftovers(): Promise<void> {
    const versionsDir = gildeLiveVersionsDir(this.home);
    let entries: string[];
    try {
      entries = await readdir(versionsDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(versionsDir, entry);
      if (entry.includes('.staging-')) {
        await rm(full, { recursive: true, force: true }).catch(() => {});
        continue;
      }
      if (entry.endsWith('.previous')) {
        const target = full.slice(0, -'.previous'.length);
        if (!entries.includes(entry.slice(0, -'.previous'.length))) {
          await rename(full, target).catch(() => {});
        } else {
          await rm(full, { recursive: true, force: true }).catch(() => {});
        }
      }
    }
  }

  private async validateActiveAtBoot(): Promise<void> {
    const active = this.state.activeVersion;
    if (!active) {
      await this.pruneVersionsExcept(null);
      return;
    }
    const reason = await this.activeInvalidReason(active);
    if (!reason) {
      await this.pruneVersionsExcept(active);
      return;
    }
    log.info(`cached live gilde ${active} not usable (${reason}); serving bundled content`);
    this.state = {
      ...this.state,
      activeVersion: null,
      integrity: undefined,
      installedAt: undefined,
    };
    await this.writeState().catch((err) =>
      log.warn(`state write failed: ${flattenErrorMessage(err)}`),
    );
    await rm(gildeLiveVersionsDir(this.home), { recursive: true, force: true }).catch(() => {});
  }

  private async activeInvalidReason(active: string): Promise<string | null> {
    if (envOverride()) return null; // override wins anyway; keep the cache untouched
    if (!isGildeReleaseVersion(active)) return 'recorded version is malformed';
    const bundled = this.bundledVersion;
    if (!bundled) return 'bundled pin unresolvable';
    const [activeMajor, activeMinor] = active.split('.');
    const [pinMajor, pinMinor] = bundled.split('.');
    if (activeMajor !== pinMajor || activeMinor !== pinMinor) {
      return `off the bundled pin's ${pinMajor}.${pinMinor} line`;
    }
    if (compareRelease(active, bundled) <= 0) return `superseded by bundled ${bundled}`;
    const config = await this.store.readConfig().catch(() => null);
    if (!config || config.gildeUpdates?.enabled !== true) return 'live updates are disabled';
    try {
      const raw = await readFile(
        join(gildeLiveVersionDir(this.home, active), 'package', 'package.json'),
        'utf8',
      );
      const parsed = JSON.parse(raw) as { name?: unknown; version?: unknown };
      if (parsed.name !== GILDE_PACKAGE_NAME || parsed.version !== active) {
        return 'extracted package identity mismatch';
      }
    } catch {
      return 'extracted package missing or unreadable';
    }
    return null;
  }

  private async pruneVersionsExcept(keep: string | null): Promise<void> {
    const versionsDir = gildeLiveVersionsDir(this.home);
    let entries: string[];
    try {
      entries = await readdir(versionsDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (keep && entry === keep) continue;
      await rm(join(versionsDir, entry), { recursive: true, force: true }).catch(() => {});
    }
  }
}

function envOverride(): boolean {
  return Boolean(process.env.GEZEL_GILDE_DATA_DIR?.trim());
}

async function readBundledGildeVersion(): Promise<string | null> {
  try {
    const raw = await readFile(join(gildePackageRoot(), 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' && isGildeReleaseVersion(parsed.version)
      ? parsed.version
      : null;
  } catch {
    return null;
  }
}

async function readState(home: string): Promise<GildeLiveState> {
  try {
    const raw = await readFile(gildeLiveStateFile(home), 'utf8');
    const parsed = GildeLiveStateSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch {
    /* fresh install or corrupt state — start clean */
  }
  return { activeVersion: null };
}

function unref(timer: { unref?: () => void }): void {
  timer.unref?.();
}
