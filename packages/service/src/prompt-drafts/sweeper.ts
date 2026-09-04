import { DEFAULT_PROMPT_DRAFT_KEEP_SENT_DAYS, createLogger } from '@bendyline/gezel';
import type { Store } from '../fs/store.js';
import type { PromptDraftManager } from './manager.js';

/**
 * Daily removal of prompt drafts that were sent long enough ago that keeping
 * them is hoarding rather than convenience.
 *
 * Two deliberate asymmetries. An UNSENT draft is never touched, however old:
 * the whole promise of the feature is that a prompt you are still working on
 * waits for you. And the sweep does delete the `message_files/` an old
 * transcript still displays, which is why the default window is generous and
 * why `keepSentDays: 0` (keep forever) is a supported answer rather than a
 * disabled feature.
 *
 * No engagement-mode gate and no LLM call — this is disk hygiene, not work.
 */

const log = createLogger('prompt-drafts');

const STARTUP_DELAY_MS = 10 * 60_000;
const SWEEP_INTERVAL_MS = 24 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

export interface PromptDraftSweeperOptions {
  store: Store;
  drafts: PromptDraftManager;
  intervalMs?: number;
  startupDelayMs?: number;
  now?: () => Date;
}

export interface PromptDraftSweepResult {
  projects: number;
  deleted: number;
}

export class PromptDraftSweeper {
  private readonly store: Store;
  private readonly drafts: PromptDraftManager;
  private readonly intervalMs: number;
  private readonly startupDelayMs: number;
  private readonly now: () => Date;

  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private sweeping = false;

  constructor(opts: PromptDraftSweeperOptions) {
    this.store = opts.store;
    this.drafts = opts.drafts;
    this.intervalMs = opts.intervalMs ?? SWEEP_INTERVAL_MS;
    this.startupDelayMs = opts.startupDelayMs ?? STARTUP_DELAY_MS;
    this.now = opts.now ?? (() => new Date());
  }

  start(): void {
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      void this.sweep().catch((err) => log.warn(`startup sweep failed: ${describe(err)}`));
    }, this.startupDelayMs);
    unref(this.startupTimer);
    this.sweepTimer = setInterval(() => {
      void this.sweep().catch((err) => log.warn(`sweep failed: ${describe(err)}`));
    }, this.intervalMs);
    unref(this.sweepTimer);
  }

  stop(): void {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.startupTimer = null;
    this.sweepTimer = null;
  }

  async sweep(): Promise<PromptDraftSweepResult> {
    if (this.sweeping) return { projects: 0, deleted: 0 };
    this.sweeping = true;
    try {
      const config = await this.store.readConfig();
      const days = config.promptDrafts?.keepSentDays ?? DEFAULT_PROMPT_DRAFT_KEEP_SENT_DAYS;
      if (days <= 0) return { projects: 0, deleted: 0 };
      const cutoff = new Date(this.now().getTime() - days * DAY_MS).toISOString();
      const projects = await this.store.listProjects();
      let deleted = 0;
      for (const project of projects) {
        try {
          deleted += await this.drafts.sweepSent(project.id, cutoff);
        } catch (err) {
          log.warn(`sweep failed for ${project.id}: ${describe(err)}`);
        }
      }
      if (deleted > 0) log.info(`swept ${deleted} sent prompt draft(s) older than ${days}d`);
      return { projects: projects.length, deleted };
    } finally {
      this.sweeping = false;
    }
  }
}

function unref(timer: ReturnType<typeof setTimeout>): void {
  (timer as unknown as { unref?: () => void }).unref?.();
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
