import type { EngineStatsEvent } from '../streaming-session.js';
import { readProcessRssBytes } from './runtime-diagnostics.js';

/**
 * Sample how much memory the engine is holding, a moment after it reports
 * itself ready — mlx_lm doesn't log buffer allocations the way llama.cpp
 * does. We delay 2s so memory-mapped weights have settled; earlier samples
 * undercount.
 *
 * Physical footprint, not RSS. Metal's unified-memory allocations — KV,
 * activation buffers, MLX's retained buffer cache — never appear in RSS, so
 * RSS reported 30 GB for an engine whose real footprint was ~103 GB, and
 * the pill disagreed 3.6x with the memory strip (which samples footprint)
 * about the same process. RSS stays as the fallback for hosts where
 * `footprint` is unavailable; it is a floor, not a lie.
 */
export class MlxEngineStatsSampler {
  /**
   * Replayed to sessions that register after the engine finishes loading —
   * same pattern as llama-cpp's `lastEngineStats` — so a chat started mid-run
   * can surface the memory footprint in the pill dropdown without restarting
   * the engine.
   */
  private last: EngineStatsEvent | null = null;
  /**
   * Guards against multiple samples from a single "ready" line (e.g. when
   * uvicorn logs both "Application startup complete" and "Uvicorn running" —
   * both classify as `ready`).
   */
  private pending = false;

  constructor(
    private readonly opts: {
      pid: () => number | undefined;
      publish: (stats: EngineStatsEvent) => void;
    },
  ) {}

  get latest(): EngineStatsEvent | null {
    return this.last;
  }

  schedule(): void {
    if (this.pending) return;
    this.pending = true;
    setTimeout(async () => {
      try {
        const pid = this.opts.pid();
        if (!pid) return;
        const { sampleDarwinProcessFootprintBytes } = await import(
          '../../system/gezel-process-memory.js'
        );
        const footprintBytes = await sampleDarwinProcessFootprintBytes({ pid });
        const rssBytes = footprintBytes ?? (await readProcessRssBytes(pid));
        if (rssBytes === null) return;
        const stats: EngineStatsEvent = { provider: 'mlx', ramAllocBytes: rssBytes };
        this.last = stats;
        this.opts.publish(stats);
      } finally {
        this.pending = false;
      }
    }, 2_000).unref?.();
  }
}
