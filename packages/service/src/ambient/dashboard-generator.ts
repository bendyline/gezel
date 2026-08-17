import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type AmbientDashboardResolution,
  type AmbientDashboardState,
  AmbientDashboardStateSchema,
  type AmbientDashboardStyle,
  type GezelConfig,
  createLogger,
  isEngagementAllowed,
  isProactiveAllowed,
  isSchedulingAllowed,
} from '@bendyline/gezel';
import {
  ambientDashboardLatestFile,
  ambientDashboardStateFile,
  ambientDir,
} from '@bendyline/gezel/paths';
import type { ChatEventBus } from '../chat/events.js';
import type { ActivityTracker } from '../fs/activity-tracker.js';
import { copyFileAtomic, writeFileAtomic } from '../fs/atomic.js';
import type { Store } from '../fs/store.js';
import type { HistoryManager } from '../history/manager.js';
import {
  type ProjectContext,
  collectProjectContexts,
  hashProjectContexts,
  renderProjectContextSections,
} from '../meester/collect.js';
import { isChromiumNotReadyError } from '../rendering/managed-browser.js';
import { type AmbientDashboardRenderer, renderAmbientDashboard } from './dashboard-render.js';
import { DEFAULT_THEME_ID } from './dashboard-themes.js';

/**
 * The ambient dashboard — the meester periodically composes a squisq
 * dashboard document (6-9 short markdown blocks) summarizing the whole
 * workshop, rendered to a PNG under `~/.gezel/ambient/` for the OS
 * ambient-display integration (wallpaper / lock-screen rotation).
 *
 * Same lifecycle discipline as MeesterStatusGenerator: unref'd sweep,
 * gated by config + engagement + chat-idle, idempotent via an input
 * hash. Opt-in (default OFF) — every run burns an LLM call plus a
 * Chromium render — and throttled by `intervalMinutes` instead of a
 * daily budget: the interval is the budget. The LLM call is enqueued
 * with `ambient: true` (wired in service.ts), so on local engines it
 * additionally yields to any interactive work.
 */

const log = createLogger('ambient-dashboard');

const STARTUP_DELAY_MS = 10 * 60_000;
const SWEEP_INTERVAL_MS = 15 * 60_000;
const ONE_SHOT_TIMEOUT_MS = 180_000;
const PROMPT_INPUT_CAP = 12_000;

export const DEFAULT_INTERVAL_MINUTES = 60;
export const DEFAULT_KEEP = 48;
export const DEFAULT_RESOLUTION: AmbientDashboardResolution = 'fhd';
export const DEFAULT_STYLE: AmbientDashboardStyle = 'panel';

const DATED_FILE_RE = /^dashboard-\d{8}-\d{4}\.png$/;

/**
 * Both meester ambient generators' events are invisible to this one —
 * otherwise each status report (or our own last render) reads as "new
 * activity" and the input hash never converges.
 */
const EXCLUDED_EVENT_KINDS = ['meester.dashboard.generated', 'meester.status.generated'] as const;

export type DashboardOneShot = (
  prompt: string,
  timeoutMs: number,
  opts: { gezelId: string; jobLabel: string },
) => Promise<string>;

export interface AmbientDashboardGeneratorOptions {
  home: string;
  store: Store;
  history: HistoryManager;
  activity: ActivityTracker;
  oneShot: DashboardOneShot;
  renderer?: AmbientDashboardRenderer;
  /** Night shift counts as "scheduled work allowed". */
  isNightShiftActive?: () => boolean;
  isChatActive?: () => boolean;
  events?: Pick<ChatEventBus, 'publishGlobalEvent'>;
  intervalMs?: number;
  startupDelayMs?: number;
  now?: () => Date;
}

export class AmbientDashboardGenerator {
  private readonly home: string;
  private readonly store: Store;
  private readonly history: HistoryManager;
  private readonly activity: ActivityTracker;
  private readonly oneShot: DashboardOneShot;
  private readonly renderer: AmbientDashboardRenderer;
  private readonly isNightShiftActive: () => boolean;
  private readonly isChatActive: () => boolean;
  private readonly events?: Pick<ChatEventBus, 'publishGlobalEvent'>;
  private readonly intervalMs: number;
  private readonly startupDelayMs: number;
  private readonly now: () => Date;

  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(opts: AmbientDashboardGeneratorOptions) {
    this.home = opts.home;
    this.store = opts.store;
    this.history = opts.history;
    this.activity = opts.activity;
    this.oneShot = opts.oneShot;
    this.renderer = opts.renderer ?? renderAmbientDashboard;
    this.isNightShiftActive = opts.isNightShiftActive ?? (() => false);
    this.isChatActive = opts.isChatActive ?? (() => false);
    this.events = opts.events;
    this.intervalMs = opts.intervalMs ?? SWEEP_INTERVAL_MS;
    this.startupDelayMs = opts.startupDelayMs ?? STARTUP_DELAY_MS;
    this.now = opts.now ?? (() => new Date());
  }

  start(): void {
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      void this.sweep().catch((err) => log.warn(`startup sweep failed: ${describe(err)}`));
    }, this.startupDelayMs);
    this.startupTimer.unref?.();
    this.sweepTimer = setInterval(() => {
      void this.sweep().catch((err) => log.warn(`sweep failed: ${describe(err)}`));
    }, this.intervalMs);
    this.sweepTimer.unref?.();
  }

  stop(): void {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.startupTimer = null;
    this.sweepTimer = null;
  }

  isRunning(): boolean {
    return this.running;
  }

  async readState(): Promise<AmbientDashboardState> {
    try {
      const raw = await readFile(ambientDashboardStateFile(this.home), 'utf8');
      return AmbientDashboardStateSchema.parse(JSON.parse(raw));
    } catch {
      return {};
    }
  }

  /** One automatic pass through the full gating chain. Exposed for tests. */
  async sweep(): Promise<boolean> {
    if (this.running) return false;
    const config = await this.store.readConfig().catch(() => null);
    const meesterId = config?.meesterGezelId;
    if (!config || config.ambientDashboard?.enabled !== true || !meesterId) return false;

    const nightShift = this.isNightShiftActive();
    if (!isProactiveAllowed(config) && !(isSchedulingAllowed(config) && nightShift)) return false;
    if (this.isChatActive()) return false;

    const now = this.now();
    const state = await this.readState();
    const intervalMinutes = config.ambientDashboard?.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES;
    if (state.lastRunAt) {
      const sinceLast = now.getTime() - Date.parse(state.lastRunAt);
      if (Number.isFinite(sinceLast) && sinceLast < intervalMinutes * 60_000) return false;
    }

    const candidates = await this.collectCandidates();
    if (candidates.length === 0) return false;
    const inputHash = hashDashboardInputs(candidates, config);
    if (inputHash === state.inputHash) return false;

    return this.generate(config, meesterId, candidates, {
      trigger: 'auto',
      state,
      inputHash,
    });
  }

  /**
   * User-requested run. Bypasses the throttle and change gates — only
   * the enabled/meester/engagement floor applies.
   */
  async runNow(): Promise<boolean> {
    if (this.running) return false;
    const config = await this.store.readConfig().catch(() => null);
    const meesterId = config?.meesterGezelId;
    if (!config || config.ambientDashboard?.enabled !== true || !meesterId) return false;
    if (!isEngagementAllowed(config)) return false;
    const state = await this.readState();
    const candidates = await this.collectCandidates();
    return this.generate(config, meesterId, candidates, {
      trigger: 'manual',
      state,
      inputHash: hashDashboardInputs(candidates, config),
    });
  }

  private async generate(
    config: GezelConfig,
    meesterId: string,
    candidates: ProjectContext[],
    opts: { trigger: 'auto' | 'manual'; state: AmbientDashboardState; inputHash: string },
  ): Promise<boolean> {
    this.running = true;
    this.events?.publishGlobalEvent({ type: 'ambient_dashboard', state: 'started' });
    try {
      const now = this.now();
      const prompt = buildDashboardPrompt(candidates, now);
      const raw = await this.oneShot(prompt, ONE_SHOT_TIMEOUT_MS, {
        gezelId: meesterId,
        jobLabel: 'ambient dashboard',
      });

      const markdown = extractMarkdown(raw);
      if (!markdown) {
        log.warn('model output had no usable markdown — keeping prior dashboard');
        await this.writeState(opts, now, { preserveInputHash: true });
        this.events?.publishGlobalEvent({ type: 'ambient_dashboard', state: 'failed' });
        return false;
      }

      const dir = ambientDir(this.home);
      await mkdir(dir, { recursive: true });
      const filename = datedFilename(now);
      const outputPath = join(dir, filename);

      const rendered = await this.renderer({
        home: this.home,
        markdown,
        outputPath,
        resolution: config.ambientDashboard?.resolution ?? DEFAULT_RESOLUTION,
        themeId: config.ambientDashboard?.themeId ?? DEFAULT_THEME_ID,
        displayTarget: config.ambientDashboard?.displayTarget,
        style: config.ambientDashboard?.style ?? DEFAULT_STYLE,
        documentTitle: defaultTitle(now),
      });

      // The stable copy the OS slideshow / humans point at. Atomic so a
      // wallpaper watcher never reads a partial PNG.
      await copyFileAtomic(outputPath, ambientDashboardLatestFile(this.home));
      await this.prune(dir, config.ambientDashboard?.keep ?? DEFAULT_KEEP, filename);
      await this.writeState(opts, now, { lastFile: filename });
      await this.history.log({
        kind: 'meester.dashboard.generated',
        gezelId: meesterId,
        summary: `Ambient dashboard generated (${rendered.blocks} blocks, ${rendered.width}x${rendered.height})`,
        details: {
          trigger: opts.trigger,
          projects: candidates.length,
          filename,
        },
      });
      this.events?.publishGlobalEvent({
        type: 'ambient_dashboard',
        state: 'ended',
        generatedAt: now.toISOString(),
        filename,
      });
      log.info(`dashboard generated (${opts.trigger}, ${rendered.blocks} blocks → ${filename})`);
      return true;
    } catch (err) {
      if (isChromiumNotReadyError(err)) {
        // First-boot window: the browser download hasn't finished. Skip
        // without consuming state so the next sweep retries in full.
        log.info('chromium not ready yet — skipping this run');
        if (opts.trigger === 'manual') {
          this.events?.publishGlobalEvent({ type: 'ambient_dashboard', state: 'failed' });
        }
        return false;
      }
      log.warn(`dashboard run failed: ${describe(err)}`);
      await this.writeState(opts, this.now(), { preserveInputHash: true }).catch(() => undefined);
      this.events?.publishGlobalEvent({ type: 'ambient_dashboard', state: 'failed' });
      return false;
    } finally {
      this.running = false;
    }
  }

  /**
   * A failed run still advances `lastRunAt` — a chronically-failing
   * model must not retry every sweep. The input hash only advances on
   * success, so the next allowed run retries the same input.
   */
  private async writeState(
    opts: { state: AmbientDashboardState; inputHash: string },
    now: Date,
    extra: { preserveInputHash?: boolean; lastFile?: string } = {},
  ): Promise<void> {
    await mkdir(ambientDir(this.home), { recursive: true });
    const next: AmbientDashboardState = {
      lastRunAt: now.toISOString(),
      inputHash: extra.preserveInputHash ? opts.state.inputHash : opts.inputHash,
      lastFile: extra.lastFile ?? opts.state.lastFile,
    };
    await writeFileAtomic(ambientDashboardStateFile(this.home), JSON.stringify(next, null, 2));
  }

  private async collectCandidates(): Promise<ProjectContext[]> {
    return collectProjectContexts(
      { store: this.store, history: this.history, activity: this.activity },
      { now: this.now(), excludeEventKinds: EXCLUDED_EVENT_KINDS },
    );
  }

  /**
   * Keep the newest `keep` dated PNGs. Only `dashboard-*.png` files are
   * eligible — never `latest.png`, the applier's `applied-*.png` slots,
   * or the state files. Stray temp files from a crashed render go too.
   */
  private async prune(dir: string, keep: number, justWrote: string): Promise<void> {
    const entries = await readdir(dir).catch(() => [] as string[]);
    const dated = entries.filter((name) => DATED_FILE_RE.test(name)).sort();
    const excess = dated.slice(0, Math.max(0, dated.length - keep));
    for (const name of excess) {
      if (name === justWrote) continue;
      await unlink(join(dir, name)).catch(() => undefined);
    }
    for (const name of entries) {
      if (name.endsWith('.tmp')) await unlink(join(dir, name)).catch(() => undefined);
    }
  }
}

/**
 * A monitor, style, or theme change is a meaningful dashboard input even when
 * the workshop summary itself is unchanged. Folding renderer-owned settings
 * into the fingerprint prevents an old cropped/light image from remaining the
 * latest wallpaper indefinitely after those preferences move.
 */
function hashDashboardInputs(candidates: ProjectContext[], config: GezelConfig): string {
  const dashboard = config.ambientDashboard;
  const renderSettings = JSON.stringify({
    resolution: dashboard?.resolution ?? DEFAULT_RESOLUTION,
    themeId: dashboard?.themeId ?? DEFAULT_THEME_ID,
    displayTarget: dashboard?.displayTarget ?? null,
    style: dashboard?.style ?? DEFAULT_STYLE,
  });
  return createHash('sha256')
    .update(hashProjectContexts(candidates))
    .update('\n')
    .update(renderSettings)
    .digest('hex');
}

function datedFilename(now: Date): string {
  const y = now.getFullYear();
  const mo = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const h = String(now.getHours()).padStart(2, '0');
  const mi = String(now.getMinutes()).padStart(2, '0');
  return `dashboard-${y}${mo}${d}-${h}${mi}.png`;
}

function defaultTitle(now: Date): string {
  const formatted = now.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  });
  return `The Workshop — ${formatted}`;
}

/**
 * The model is asked for a bare markdown document; tolerate it wrapping
 * the whole thing in a single ```markdown fence anyway.
 */
export function extractMarkdown(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const fence = trimmed.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n?```$/);
  const body = (fence?.[1] ?? trimmed).trim();
  return body || null;
}

function buildDashboardPrompt(candidates: ProjectContext[], now: Date): string {
  const sections = renderProjectContextSections(candidates);
  const input = sections.join('\n\n').slice(0, PROMPT_INPUT_CAP);

  return `You are composing the workshop's ambient dashboard — a single glanceable screen (it becomes the user's wallpaper) summarizing the whole workshop. Below is the current state of every active project.

${input}

Return ONLY a squisq markdown document (no prose before or after it) shaped like:

---
squisq-dashboard-layout: auto
squisq-dashboard-style: panel
title: <short dashboard title, e.g. "The Workshop — ${defaultTitle(now).split(' — ')[1]}">
---

## <block heading>
<1-3 short lines>

Rules:
- 6 to 9 top-level "##" blocks; each block becomes one dashboard cell.
- Block 1 is the day's headline: the single most exciting development, one bold sentence.
- Then one block per notable project (most active first): status, what moved, what's next.
- Add one "Needs you" block when questions or draft tasks wait on the user (counts + project names).
- Optionally one "Highlight" block quoting a great line or result from recent activity.
- Each block is at most ~40 words. Short lists and small markdown tables are fine.
- No images, no links, no code blocks. Ground every statement in the activity above; no speculation.`;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
