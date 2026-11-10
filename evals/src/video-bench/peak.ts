/**
 * Peak memory of a trial's engine processes.
 *
 * On macOS `footprint` reports `phys_footprint_peak`, a lifetime maximum that
 * cannot miss a short spike. It counts only pages the process itself
 * touched: ggml's Metal compute buffers are written by the GPU alone, so
 * during sampling a 2.4 GB LingBot buffer and an 856 MB Wan2.1 one never
 * appeared in it, while the GPU driver's "In use system memory" held them
 * (M5 Max, 2026-11-09). So each poll also adds what the GPU driver holds
 * beyond its level before the engine started, in place of the Metal buffers
 * the process touched itself (the `Untagged` category), and a clip's peak is
 * the larger of the two. The driver's figure covers every process, so the
 * machine must be otherwise idle. Elsewhere this falls back to the image
 * bench's `MemoryWatch` (Linux MemAvailable drop and VmRSS).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { type MemoryPeak, MemoryWatch } from '../image-bench/memory.ts';

const run = promisify(execFile);
const POLL_MS = 1_000;

/** What the poll behind a clip's GPU-aware peak read, to check it by hand. */
export interface GpuPeakParts {
  footprint: number;
  untagged: number;
  graphics: number;
  gpuDelta: number;
}

export interface EnginePeak {
  /** Largest lifetime peak of any one engine process, bytes. */
  processPeakBytes: number | null;
  /** The same across all engine processes at once, summed per sample of current footprint. */
  sampledTotalBytes: number | null;
  /**
   * macOS: the most the engines held at one poll, counting Metal buffers as
   * the GPU driver holds them rather than as the process touched them.
   */
  gpuSampledBytes: number | null;
  /** Linux only: the fall in available memory from the baseline. */
  systemDropBytes: number | null;
  source: 'footprint' | 'meminfo' | 'none';
}

export interface FootprintReading {
  current: number;
  peak: number;
  /** Dirty bytes in the `Untagged` category: where ggml's Metal buffers sit. */
  untagged: number;
  /**
   * Dirty bytes in the GPU's own categories (`IOAccelerator`, `IOSurface`,
   * `Owned physical footprint ... (graphics)`): memory the GPU driver's
   * figure counts too.
   */
  graphics: number;
}

const GRAPHICS_CATEGORY = /^(IOAccelerator|IOSurface|Owned physical footprint).*$/;

/** Dirty bytes per category from one process block. */
function categoryBytes(block: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of block.matchAll(/^\s*(\d+) B\s+\d+ B\s+\d+ B\s+\d+\s+(.+?)\s*$/gm)) {
    const name = m[2] as string;
    out.set(name, (out.get(name) ?? 0) + Number(m[1]));
  }
  return out;
}

/** Per process, from `footprint --format bytes`: footprint now, its lifetime peak, and `Untagged`. */
export function parseFootprintPeaks(stdout: string): FootprintReading[] {
  const out: FootprintReading[] = [];
  for (const block of stdout.split(/^=+$/m)) {
    const current = /phys_footprint:\s*(\d+)\s+B/.exec(block);
    const peak = /phys_footprint_peak:\s*(\d+)\s+B/.exec(block);
    if (current && peak) {
      const categories = categoryBytes(block);
      let graphics = 0;
      for (const [name, bytes] of categories) {
        if (GRAPHICS_CATEGORY.test(name)) graphics += bytes;
      }
      out.push({
        current: Number(current[1]),
        peak: Number(peak[1]),
        untagged: categories.get('Untagged') ?? 0,
        graphics,
      });
    }
  }
  return out;
}

/** The GPU driver's "In use system memory", from `ioreg -c IOAccelerator`. */
export function parseGpuInUse(stdout: string): number | null {
  const m = /"In use system memory"=(\d+)/.exec(stdout);
  return m ? Number(m[1]) : null;
}

async function gpuInUse(): Promise<number | null> {
  const stdout = await run('/usr/sbin/ioreg', ['-r', '-d', '1', '-w', '0', '-c', 'IOAccelerator'], {
    maxBuffer: 4 * 1024 * 1024,
  })
    .then((r) => r.stdout)
    .catch(() => '');
  return parseGpuInUse(stdout);
}

export class EnginePeakWatch {
  private timer: NodeJS.Timeout | undefined;
  private peak = 0;
  private sampledTotal = 0;
  private gpuSampled = 0;
  private clipGpuSampled = 0;
  private clipGpuParts: GpuPeakParts | undefined;
  private gpuBaseline: number | null = null;
  private sampled = false;
  private readonly linux: MemoryWatch | undefined;

  constructor(private readonly pids: () => Promise<number[]>) {
    this.linux = process.platform === 'linux' ? new MemoryWatch(pids) : undefined;
  }

  async begin(): Promise<void> {
    if (this.linux) return this.linux.begin();
    if (process.platform !== 'darwin') return;
    this.gpuBaseline = await gpuInUse();
    this.timer = setInterval(() => void this.sample(), POLL_MS);
    this.timer.unref?.();
  }

  /**
   * Read now; call before the engine is stopped so its lifetime peak is not
   * lost. Returns the largest lifetime peak seen so far: rendering sizes in
   * ascending order makes it each clip's own peak.
   */
  async sample(): Promise<number | null> {
    if (process.platform !== 'darwin') return null;
    const pids = await this.pids().catch(() => []);
    if (pids.length === 0) return this.sampled ? this.peak : null;
    const args = ['--format', 'bytes', ...pids.flatMap((p) => ['-p', String(p)])];
    const [stdout, gpu] = await Promise.all([
      run('/usr/bin/footprint', args, { maxBuffer: 4 * 1024 * 1024 })
        .then((r) => r.stdout)
        .catch((err: { stdout?: string }) => err.stdout ?? ''),
      this.gpuBaseline === null ? Promise.resolve(null) : gpuInUse(),
    ]);
    const procs = parseFootprintPeaks(stdout);
    if (procs.length === 0) return this.sampled ? this.peak : null;
    this.sampled = true;
    this.peak = Math.max(this.peak, ...procs.map((p) => p.peak));
    const current = procs.reduce((sum, p) => sum + p.current, 0);
    this.sampledTotal = Math.max(this.sampledTotal, current);
    if (gpu !== null && this.gpuBaseline !== null) {
      // Host memory is what the footprint holds outside the Metal buffers and
      // the GPU's own categories, which the driver's figure already counts.
      const untagged = procs.reduce((sum, p) => sum + p.untagged, 0);
      const graphics = procs.reduce((sum, p) => sum + p.graphics, 0);
      const hostOnly = Math.max(0, current - untagged - graphics);
      const gpuDelta = Math.max(0, gpu - this.gpuBaseline);
      const held = hostOnly + gpuDelta;
      this.gpuSampled = Math.max(this.gpuSampled, held);
      if (held > this.clipGpuSampled) {
        this.clipGpuSampled = held;
        this.clipGpuParts = { footprint: current, untagged, graphics, gpuDelta };
      }
    }
    return this.peak;
  }

  /**
   * One clip's peak: the engine's lifetime footprint peak (each clip's own
   * when sizes ascend) or, when larger, the most it held at one poll since
   * the last clip with Metal buffers counted as the GPU driver holds them.
   * Read before the engine stops.
   */
  async clipPeak(): Promise<{
    bytes: number;
    footprintBytes: number;
    gpuBytes?: number;
    gpuParts?: GpuPeakParts;
  } | null> {
    const footprint = await this.sample();
    if (footprint === null) return null;
    const gpu = this.clipGpuSampled;
    const parts = this.clipGpuParts;
    this.clipGpuSampled = 0;
    this.clipGpuParts = undefined;
    return {
      bytes: Math.max(footprint, gpu),
      footprintBytes: footprint,
      ...(gpu > 0 ? { gpuBytes: gpu } : {}),
      ...(parts ? { gpuParts: parts } : {}),
    };
  }

  async end(): Promise<EnginePeak> {
    if (this.timer) clearInterval(this.timer);
    if (this.linux) {
      const peak: MemoryPeak = await this.linux.peak();
      await this.linux.end();
      return {
        processPeakBytes: peak.processRssBytes,
        sampledTotalBytes: peak.processRssBytes,
        gpuSampledBytes: null,
        systemDropBytes: peak.systemDropBytes,
        source: 'meminfo',
      };
    }
    return {
      processPeakBytes: this.sampled ? this.peak : null,
      sampledTotalBytes: this.sampled ? this.sampledTotal : null,
      gpuSampledBytes: this.gpuSampled > 0 ? this.gpuSampled : null,
      systemDropBytes: null,
      source: this.sampled ? 'footprint' : 'none',
    };
  }
}
