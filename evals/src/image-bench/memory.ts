/**
 * Peak memory while an image engine works, measured from outside.
 *
 * A process's resident set misses what a GPU driver holds for it, and on a
 * unified-memory machine (DGX Spark, Apple Silicon) that is most of an image
 * model. So the watch records the drop in the system's available memory from
 * a baseline taken before the engine started, alongside the engine's own
 * resident peak. Anything else allocating during the window inflates the
 * drop: run on a quiet machine. Linux only; elsewhere both read as null.
 */
import { readFile } from 'node:fs/promises';

export interface MemoryPeak {
  /** Largest fall in MemAvailable below the baseline, in bytes. */
  systemDropBytes: number | null;
  /** Largest resident set of any watched process, in bytes. */
  processRssBytes: number | null;
}

async function memAvailableBytes(): Promise<number | null> {
  try {
    const text = await readFile('/proc/meminfo', 'utf8');
    const kb = text.match(/^MemAvailable:\s+(\d+) kB/m)?.[1];
    return kb ? Number(kb) * 1024 : null;
  } catch {
    return null;
  }
}

async function rssBytes(pid: number): Promise<number | null> {
  try {
    const text = await readFile(`/proc/${pid}/status`, 'utf8');
    const kb = text.match(/^VmRSS:\s+(\d+) kB/m)?.[1];
    return kb ? Number(kb) * 1024 : null;
  } catch {
    return null;
  }
}

export class MemoryWatch {
  private baseline: number | null = null;
  private minAvailable: number | null = null;
  private maxRss: number | null = null;
  private timer: NodeJS.Timeout | undefined;
  private busy = false;

  constructor(
    private readonly pids: () => Promise<readonly number[]>,
    private readonly intervalMs = 250,
  ) {}

  /** Take the baseline. Call before the engine starts. */
  async begin(): Promise<void> {
    this.baseline = await memAvailableBytes();
    this.minAvailable = this.baseline;
    this.maxRss = null;
    this.timer = setInterval(() => void this.sample(), this.intervalMs);
  }

  private async sample(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const available = await memAvailableBytes();
      if (available !== null && (this.minAvailable === null || available < this.minAvailable)) {
        this.minAvailable = available;
      }
      for (const pid of await this.pids()) {
        const rss = await rssBytes(pid);
        if (rss !== null && (this.maxRss === null || rss > this.maxRss)) this.maxRss = rss;
      }
    } finally {
      this.busy = false;
    }
  }

  /** Read the peak so far without stopping. */
  async peak(): Promise<MemoryPeak> {
    await this.sample();
    return {
      systemDropBytes:
        this.baseline !== null && this.minAvailable !== null
          ? Math.max(0, this.baseline - this.minAvailable)
          : null,
      processRssBytes: this.maxRss,
    };
  }

  async end(): Promise<MemoryPeak> {
    const result = await this.peak();
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    return result;
  }
}
