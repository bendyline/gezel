/**
 * Periodic health sweep for the memory vector index. Source-of-truth lives
 * in the daily markdown files under each gezel/project's `memories/daily/`
 * — the vector index is a derived cache. Both the user (via direct edits
 * to the markdown) and bugs (the previously-broken `LocalIndex` constructor
 * that left every index empty) can leave the cache out of sync. This sweep
 * notices that drift and rebuilds the affected index from markdown.
 *
 * Triggered:
 *   - Once at service boot (delayed so it doesn't block startup)
 *   - Every 24h while the service is running
 *
 * Safe to no-op:
 *   - If transformers.js / sharp aren't installed, embeddings are disabled
 *     and we skip the sweep entirely (otherwise we'd retry the same broken
 *     pipeline every cycle).
 */

import { createLogger } from '@bendyline/gezel';
import type { Store } from '../fs/store.js';
import { parseMemoryDay } from './daily-markdown.js';
import { embedModelId } from './embed-core.js';
import { embeddingsDisabledReason } from './embeddings.js';
import type { MemoryManager } from './manager.js';
import { countIndexed, readEmbedStamp } from './vector-index.js';

const log = createLogger('memory');

const STARTUP_DELAY_MS = 5_000;
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface MemoryHealthMonitorOptions {
  memory: MemoryManager;
  store: Store;
  /** Override the periodic interval (used by tests). */
  intervalMs?: number;
  /** Override the startup delay (used by tests). */
  startupDelayMs?: number;
}

export class MemoryHealthMonitor {
  private readonly memory: MemoryManager;
  private readonly store: Store;
  private readonly intervalMs: number;
  private readonly startupDelayMs: number;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private periodicTimer: ReturnType<typeof setInterval> | null = null;
  private sweepInFlight = false;

  constructor(opts: MemoryHealthMonitorOptions) {
    this.memory = opts.memory;
    this.store = opts.store;
    this.intervalMs = opts.intervalMs ?? SWEEP_INTERVAL_MS;
    this.startupDelayMs = opts.startupDelayMs ?? STARTUP_DELAY_MS;
  }

  start(): void {
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      void this.sweep().catch((err) => {
        log.warn('[memory] startup health sweep failed:', err);
      });
    }, this.startupDelayMs);
    if (typeof (this.startupTimer as { unref?: () => void }).unref === 'function') {
      (this.startupTimer as { unref: () => void }).unref();
    }

    this.periodicTimer = setInterval(() => {
      void this.sweep().catch((err) => {
        log.warn('[memory] periodic health sweep failed:', err);
      });
    }, this.intervalMs);
    if (typeof (this.periodicTimer as { unref?: () => void }).unref === 'function') {
      (this.periodicTimer as { unref: () => void }).unref();
    }
  }

  stop(): void {
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    if (this.periodicTimer) {
      clearInterval(this.periodicTimer);
      this.periodicTimer = null;
    }
  }

  /**
   * Walk every gezel + project memory dir; rebuild any whose vector index
   * has fewer entries than the markdown source. Public so callers (tests,
   * a future `/api/memory/sweep` admin endpoint) can trigger on demand.
   */
  async sweep(): Promise<{ rebuilt: number; checked: number }> {
    if (this.sweepInFlight) return { rebuilt: 0, checked: 0 };
    if (embeddingsDisabledReason()) return { rebuilt: 0, checked: 0 };
    this.sweepInFlight = true;
    try {
      const [gezels, projects] = await Promise.all([
        this.store.listGezels(),
        this.store.listProjects(),
      ]);
      const targets: Array<{ scope: 'gezel' | 'project'; id: string }> = [
        ...gezels.map((g) => ({ scope: 'gezel' as const, id: g.id })),
        ...projects.map((p) => ({ scope: 'project' as const, id: p.id })),
      ];
      let rebuilt = 0;
      for (const t of targets) {
        try {
          if (await this.needsRebuild(t.scope, t.id)) {
            await this.memory.reindex(t.scope, t.id);
            rebuilt++;
          }
        } catch (err) {
          log.warn(`[memory] sweep failed for ${t.scope}/${t.id}:`, err);
        }
      }
      if (rebuilt > 0) {
        log.info(`[memory] health sweep rebuilt ${rebuilt}/${targets.length} index(es)`);
      }
      return { rebuilt, checked: targets.length };
    } finally {
      this.sweepInFlight = false;
    }
  }

  private async needsRebuild(scope: 'gezel' | 'project', id: string): Promise<boolean> {
    const markdownCount = await this.countMarkdownMemories(scope, id);
    if (markdownCount === 0) return false;
    const indexDir = this.store.memoryIndexDir(scope, id);
    // Embed-model swap: vectors from a different embedder aren't comparable to
    // the current model's query vectors, so a stamp mismatch forces a re-embed
    // rebuild (rebuildIndex re-stamps). A null stamp is a pre-stamp db whose
    // embedder we can't confirm — treat it as a mismatch so the one-time bge
    // cutover re-embeds every existing (MiniLM-built, unstamped) index once.
    // Rebuild stamps the current model, so subsequent sweeps are no-ops.
    const stamp = await readEmbedStamp(indexDir);
    if (stamp !== embedModelId()) return true;
    // The vector index is a derived cache; if it has fewer rows than the
    // markdown source-of-truth it drifted (manual edits, a crashed save, or a
    // store migration) → rebuild.
    const vectorCount = await countIndexed(indexDir);
    return vectorCount < markdownCount;
  }

  private async countMarkdownMemories(scope: 'gezel' | 'project', id: string): Promise<number> {
    const days = await this.store.listMemoryDays(scope, id);
    let total = 0;
    for (const day of days) {
      const content = await this.store.readMemoryDay(scope, id, day);
      // Shared parser keeps this count in lockstep with what
      // MemoryManager.allEntries would reindex — a divergent ad-hoc regex
      // here would mis-detect drift forever.
      total += parseMemoryDay(content).length;
    }
    return total;
  }
}
