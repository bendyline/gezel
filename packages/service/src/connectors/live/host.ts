/**
 * Keeps every device binding (cameras today) running while it should, and
 * stopped when it should not. Device bindings never pass through the
 * connector sync loop — that loop is idle-gated and runs every 90 seconds,
 * and a camera that only looks when the person is away from the keyboard
 * would miss the cat entirely.
 *
 * Reconciles on boot, whenever bindings or settings change, after the
 * computer wakes, and once a minute as a safety net. Each running binding
 * gets a loop: run the adapter until it stops, show why, back off, retry.
 * A watchdog restarts a run whose hardware went silent; time asleep never
 * counts as silence.
 */

import type {
  ChatEvent,
  ConnectorTypeManifest,
  GezelConfig,
  LiveBindingStatus,
  Project,
  ProjectConnectorBinding,
} from '@bendyline/gezel';
import {
  awakeNow,
  createLogger,
  getEngagementMode,
  isTaskWorkAllowed,
  onSuspension,
  resolveSecurityPolicy,
} from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import type { Store } from '../../fs/store.js';
import { liveGate } from './gating.js';
import { liveAdapterFor } from './registry.js';
import { type LiveAdapter, LiveAdapterError, type LiveRunContext } from './types.js';

const log = createLogger('live');

const BACKOFF_MS = [2_000, 10_000, 30_000, 120_000, 300_000] as const;
const WATCHDOG_EVERY_MS = 5_000;
const RECONCILE_EVERY_MS = 60_000;
/** A run that kept going this long earns a fresh backoff ladder. */
const HEALTHY_RUN_MS = 120_000;

export interface LiveHostOptions {
  store: Pick<Store, 'listProjects' | 'getProject' | 'readConfig'>;
  catalog: Pick<CatalogService, 'get'>;
  /** Persist a binding's error/pause state (under the connector lock). */
  persist(
    projectId: string,
    bindingId: string,
    patch: {
      lastError?: string | null;
      disabled?: boolean;
      disabledReason?: 'user' | 'emergency-stop';
    },
  ): Promise<void>;
  publishProject(projectId: string, event: ChatEvent): void;
  publishGlobal(event: ChatEvent): void;
  /** For tests: skip the timers. */
  timers?: boolean;
}

interface Entry {
  key: string;
  projectId: string;
  bindingId: string;
  hash: string;
  adapter: LiveAdapter;
  stopped: boolean;
  runCtrl: AbortController | null;
  lastBeat: number;
  loop: Promise<void>;
  wake: (() => void) | null;
  persistedError: string | undefined;
}

function plainMessage(err: unknown): string {
  if (err instanceof LiveAdapterError) return err.message;
  if (err instanceof Error && err.name === 'CaptureError') return err.message;
  const raw = err instanceof Error ? err.message : String(err);
  return raw ? `Stopped unexpectedly: ${raw.slice(0, 200)}` : 'Stopped unexpectedly.';
}

export class LiveConnectorHost {
  private readonly entries = new Map<string, Entry>();
  private readonly statuses = new Map<string, LiveBindingStatus>();
  private readonly manifests = new Map<string, ConnectorTypeManifest | null>();
  private config: GezelConfig = {} as GezelConfig;
  private reconciling: Promise<void> | null = null;
  private again = false;
  private stopped = false;
  private timers: Array<ReturnType<typeof setInterval>> = [];
  private offSuspension: (() => void) | null = null;
  private watching = '';
  private readonly labels = new Map<string, string>();

  constructor(private readonly opts: LiveHostOptions) {}

  start(): void {
    if (this.opts.timers !== false) {
      const watchdog = setInterval(() => this.watchdog(), WATCHDOG_EVERY_MS);
      const safety = setInterval(() => void this.reconcile(), RECONCILE_EVERY_MS);
      watchdog.unref?.();
      safety.unref?.();
      this.timers.push(watchdog, safety);
    }
    // After a sleep the device is usually gone from under ffmpeg; start
    // every run fresh rather than waiting out the watchdog.
    this.offSuspension = onSuspension(() => this.restartAll());
    void this.reconcile();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.offSuspension?.();
    await Promise.all([...this.entries.keys()].map((k) => this.stopEntry(k)));
  }

  /** Live status of a project's device bindings. */
  status(projectId: string): LiveBindingStatus[] {
    return [...this.statuses.values()].filter((s) => s.projectId === projectId);
  }

  statusFor(projectId: string, bindingId: string): LiveBindingStatus | undefined {
    return this.statuses.get(`${projectId}/${bindingId}`);
  }

  /** Every camera that is on right now, for the shell's "camera on" indicator. */
  watchingCameras(): Array<{ projectId: string; bindingId: string; name: string }> {
    return [...this.statuses.values()]
      .filter((s) => s.state === 'watching' || s.state === 'starting')
      .map((s) => ({
        projectId: s.projectId,
        bindingId: s.bindingId,
        name: this.labels.get(`${s.projectId}/${s.bindingId}`) ?? s.bindingId,
      }));
  }

  /** Bring running bindings in line with disk. Coalesces concurrent calls. */
  reconcile(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.reconciling) {
      this.again = true;
      return this.reconciling;
    }
    this.reconciling = (async () => {
      try {
        do {
          this.again = false;
          await this.reconcileOnce();
        } while (this.again && !this.stopped);
      } catch (err) {
        log.warn('reconcile failed:', err instanceof Error ? err.message : err);
      } finally {
        this.reconciling = null;
      }
    })();
    return this.reconciling;
  }

  /**
   * The panic stop: every device binding is paused and marked so that only
   * the person resuming it brings it back. Returns how many were stopped.
   */
  async emergencyStop(): Promise<number> {
    let count = 0;
    const projects = await this.opts.store.listProjects().catch(() => [] as Project[]);
    for (const p of projects) {
      for (const b of p.connectors ?? []) {
        if (b.driver !== 'device' || b.disabled) continue;
        count++;
        await this.opts
          .persist(p.id, b.id, { disabled: true, disabledReason: 'emergency-stop' })
          .catch((err) => log.warn(`emergency stop could not pause ${b.id}:`, err));
      }
    }
    await Promise.all([...this.entries.keys()].map((k) => this.stopEntry(k)));
    await this.reconcile();
    return count;
  }

  private restartAll(): void {
    for (const e of this.entries.values()) e.runCtrl?.abort('restart');
  }

  private async manifestFor(b: ProjectConnectorBinding): Promise<ConnectorTypeManifest | null> {
    const cacheKey = `${b.type}@${b.version ?? ''}@${b.sourceId ?? ''}`;
    if (this.manifests.has(cacheKey)) return this.manifests.get(cacheKey) ?? null;
    const detail = await this.opts.catalog
      .get('connector-type', b.type, b.sourceId ?? 'bundled', b.version)
      .catch(() => null);
    const manifest = detail && detail.manifest.kind === 'connector-type' ? detail.manifest : null;
    this.manifests.set(cacheKey, manifest);
    return manifest;
  }

  private async reconcileOnce(): Promise<void> {
    this.config = await this.opts.store.readConfig();
    const policy = resolveSecurityPolicy(this.config);
    const engagementOff = getEngagementMode(this.config) === 'off';
    const projects = await this.opts.store.listProjects();
    const seen = new Set<string>();
    for (const p of projects) {
      for (const b of p.connectors ?? []) {
        if (b.driver !== 'device') continue;
        const key = `${p.id}/${b.id}`;
        seen.add(key);
        const manifest = await this.manifestFor(b);
        this.labels.set(key, b.displayName?.trim() || manifest?.name || b.type);
        const source = (manifest?.source ?? {}) as { adapterId?: string; network?: boolean };
        const adapter = source.adapterId ? liveAdapterFor(source.adapterId) : undefined;
        const gate = liveGate({
          binding: b,
          project: p,
          engagementOff,
          network: source.network === true,
          allowConnectorData: policy.allowConnectorData,
        });
        if (!gate.run || !manifest || !adapter) {
          await this.stopEntry(key);
          this.setStatus(p.id, b.id, {
            state: gate.run ? 'error' : gate.state,
            reason: gate.run
              ? 'This kind of device is not supported by this version of Gezel.'
              : gate.reason,
            review: undefined,
            episode: undefined,
          });
          continue;
        }
        const hash = JSON.stringify([b.config, b.displayName, b.corpusDir, b.type, b.version]);
        const existing = this.entries.get(key);
        if (existing && existing.hash === hash && !existing.stopped) continue;
        if (existing) await this.stopEntry(key);
        this.startEntry(p, b, manifest, adapter, hash);
      }
    }
    for (const key of [...this.entries.keys()]) {
      if (!seen.has(key)) await this.stopEntry(key);
    }
    for (const key of [...this.statuses.keys()]) {
      if (!seen.has(key)) this.statuses.delete(key);
    }
    this.publishWatching();
  }

  private startEntry(
    project: Project,
    binding: ProjectConnectorBinding,
    manifest: ConnectorTypeManifest,
    adapter: LiveAdapter,
    hash: string,
  ): void {
    const key = `${project.id}/${binding.id}`;
    const entry: Entry = {
      key,
      projectId: project.id,
      bindingId: binding.id,
      hash,
      adapter,
      stopped: false,
      runCtrl: null,
      lastBeat: awakeNow(),
      loop: Promise.resolve(),
      wake: null,
      persistedError: binding.lastError,
    };
    this.entries.set(key, entry);
    entry.loop = this.runLoop(entry, project, binding, manifest);
  }

  private async runLoop(
    entry: Entry,
    project: Project,
    binding: ProjectConnectorBinding,
    manifest: ConnectorTypeManifest,
  ): Promise<void> {
    let attempts = 0;
    const label = binding.displayName?.trim() || manifest.name;
    while (!entry.stopped) {
      const ctrl = new AbortController();
      entry.runCtrl = ctrl;
      entry.lastBeat = awakeNow();
      const startedAt = awakeNow();
      let beats = 0;
      this.setStatus(entry.projectId, entry.bindingId, { state: 'starting', reason: undefined });
      const ctx: LiveRunContext = {
        project,
        binding,
        manifest,
        corpusDir: binding.corpusDir ?? `data/${binding.id}`,
        label,
        signal: ctrl.signal,
        report: (patch) => {
          if (entry.stopped || ctrl.signal.aborted) return;
          this.setStatus(entry.projectId, entry.bindingId, patch);
        },
        heartbeat: () => {
          entry.lastBeat = awakeNow();
          if (beats++ === 0) void this.clearError(entry);
        },
        reviewAllowed: () => isTaskWorkAllowed(this.config),
      };
      let failure: unknown = null;
      try {
        await entry.adapter.run(ctx);
      } catch (err) {
        failure = err;
      }
      if (entry.stopped) break;
      if (ctrl.signal.reason === 'restart') {
        await this.pause(entry, 500);
        continue;
      }
      if (ctrl.signal.aborted && ctrl.signal.reason instanceof Error)
        failure ??= ctrl.signal.reason;
      failure ??= new LiveAdapterError('Stopped unexpectedly.');
      if (awakeNow() - startedAt >= HEALTHY_RUN_MS && beats > 0) attempts = 0;
      const delay = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)] as number;
      attempts++;
      const message = plainMessage(failure);
      log.info(`${entry.key}: ${message} (retrying in ${Math.round(delay / 1000)}s)`);
      this.setStatus(entry.projectId, entry.bindingId, {
        state: 'error',
        reason: message,
        episode: undefined,
      });
      if (entry.persistedError !== message) {
        entry.persistedError = message;
        await this.opts
          .persist(entry.projectId, entry.bindingId, { lastError: message })
          .catch(() => {});
      }
      await this.pause(entry, delay);
    }
    entry.runCtrl = null;
  }

  private async clearError(entry: Entry): Promise<void> {
    if (!entry.persistedError) return;
    entry.persistedError = undefined;
    await this.opts.persist(entry.projectId, entry.bindingId, { lastError: null }).catch(() => {});
  }

  private pause(entry: Entry, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        entry.wake = null;
        resolve();
      }, ms);
      timer.unref?.();
      entry.wake = () => {
        clearTimeout(timer);
        entry.wake = null;
        resolve();
      };
    });
  }

  private async stopEntry(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.stopped = true;
    this.entries.delete(key);
    entry.runCtrl?.abort('stop');
    entry.wake?.();
    await entry.loop.catch(() => {});
  }

  private watchdog(): void {
    const now = awakeNow();
    for (const e of this.entries.values()) {
      if (!e.runCtrl || e.runCtrl.signal.aborted) continue;
      if (now - e.lastBeat > e.adapter.heartbeatTimeoutMs) {
        e.runCtrl.abort(new LiveAdapterError('The camera stopped sending pictures.'));
      }
    }
  }

  private setStatus(projectId: string, bindingId: string, patch: Partial<LiveBindingStatus>): void {
    const key = `${projectId}/${bindingId}`;
    const prior = this.statuses.get(key);
    const stateChanged = patch.state !== undefined && patch.state !== prior?.state;
    const next: LiveBindingStatus = {
      ...(prior ?? { projectId, bindingId, state: 'starting', since: new Date().toISOString() }),
      ...patch,
      projectId,
      bindingId,
      ...(stateChanged ? { since: new Date().toISOString() } : {}),
    } as LiveBindingStatus;
    for (const k of Object.keys(next) as Array<keyof LiveBindingStatus>) {
      if (next[k] === undefined) delete next[k];
    }
    this.statuses.set(key, next);
    this.opts.publishProject(projectId, {
      type: 'camera_status',
      projectId,
      bindingId,
      status: next,
    });
    if (stateChanged) this.publishWatching();
  }

  private publishWatching(): void {
    const cameras = this.watchingCameras();
    const fingerprint = cameras
      .map((c) => `${c.projectId}/${c.bindingId}`)
      .sort()
      .join('|');
    if (fingerprint === this.watching) return;
    this.watching = fingerprint;
    this.opts.publishGlobal({ type: 'cameras_watching', cameras });
  }
}
