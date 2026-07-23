import { type WriteStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { redactLogLine } from '../llama-cpp/log-redact.js';

/**
 * Rolling append-only log for the MLX server's stdout/stderr (the
 * wrapped `gezel_mlx_server.py`). Mirrors `LlamaCppLogFile` exactly —
 * different filename prefix, same rotation semantics. The duplication
 * is deliberate: the alternative is a shared package boundary, which
 * costs more than two files of trivial rotation logic at this scale
 * (same rationale captured in `LlamaCppLogFile`'s header).
 *
 * Files live at `<dir>/mlx-server-YYYY-MM-DD.log`, roll to `-1.log`
 * / `-2.log` when the active file crosses 10 MB, and ones older than
 * 7 days are swept on open.
 *
 * Why this exists: the MLX supervisor's `onLog` previously routed
 * only to `console.log`, so the python wrapper's `[cache] miss/hit/
 * saved`, `Prefill: …`, model-load, and `[stream] client
 * disconnected` lines vanished into the embedded gezeld's stdout
 * (visible only when launched from a terminal). Diagnosing the
 * "prefilling 3-4 times in a row" pattern requires the cache log
 * lines on disk; this class is the persistent trail.
 */
export class MlxLogFile {
  private stream: WriteStream | null = null;
  private currentPath: string | null = null;
  private currentDay: string | null = null;
  private rollIndex = 0;
  private bytesWritten = 0;
  private readonly maxBytes = 10 * 1024 * 1024;
  private readonly retentionDays = 7;
  private readonly readyPromise: Promise<void>;
  private pendingWrites: Promise<void> = Promise.resolve();

  constructor(private readonly dir: string) {
    this.readyPromise = this.init();
  }

  private async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await this.sweepOldFiles();
    await this.openForToday();
  }

  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private async openForToday(): Promise<void> {
    this.currentDay = this.today();
    this.rollIndex = 0;
    const base = join(this.dir, `mlx-server-${this.currentDay}.log`);
    let existingSize = 0;
    try {
      const st = await stat(base);
      existingSize = st.size;
    } catch {
      /* not present yet */
    }
    this.currentPath = base;
    this.bytesWritten = existingSize;
    this.stream = createWriteStream(base, { flags: 'a' });
  }

  private async rollIfNeeded(): Promise<void> {
    if (this.today() !== this.currentDay) {
      await this.close();
      await this.openForToday();
      return;
    }
    if (this.bytesWritten < this.maxBytes) return;
    await this.close();
    this.rollIndex += 1;
    const rolled = join(this.dir, `mlx-server-${this.currentDay}-${this.rollIndex}.log`);
    this.currentPath = rolled;
    this.bytesWritten = 0;
    this.stream = createWriteStream(rolled, { flags: 'a' });
  }

  /**
   * Fire-and-forget append. Serializes writes via an internal promise
   * chain so rotation + ordering stay correct even under bursty
   * stdout. The caller doesn't need to await individual lines; any
   * subsequent `tail()` / `close()` awaits the drain.
   */
  write(line: string): void {
    const safe = redactLogLine(line);
    const run = async () => {
      await this.readyPromise;
      await this.rollIfNeeded();
      if (!this.stream) return;
      const buf = Buffer.from(safe.endsWith('\n') ? safe : `${safe}\n`, 'utf8');
      await new Promise<void>((resolve) => {
        this.stream?.write(buf, () => resolve());
      });
      this.bytesWritten += buf.length;
    };
    this.pendingWrites = this.pendingWrites.then(run, run);
  }

  async flush(): Promise<void> {
    await this.pendingWrites;
  }

  async close(): Promise<void> {
    await this.pendingWrites;
    if (!this.stream) return;
    const s = this.stream;
    this.stream = null;
    await new Promise<void>((resolve) => s.end(() => resolve()));
  }

  /**
   * Read the last `bytes` chars of the current file. Useful for a
   * Settings → On-device → MLX engine log disclosure (mirrors the
   * llama-cpp tail surface).
   */
  async tail(bytes: number): Promise<string> {
    await this.readyPromise;
    await this.flush();
    if (!this.currentPath) return '';
    try {
      const content = await readFile(this.currentPath, 'utf8');
      return content.length <= bytes ? content : content.slice(content.length - bytes);
    } catch {
      return '';
    }
  }

  /** Absolute path of the current log file (for surfacing in UI). */
  currentFile(): string | null {
    return this.currentPath;
  }

  private async sweepOldFiles(): Promise<void> {
    const horizonMs = Date.now() - this.retentionDays * 24 * 60 * 60 * 1000;
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (!name.startsWith('mlx-server-') || !name.endsWith('.log')) continue;
      const p = join(this.dir, name);
      try {
        const st = await stat(p);
        if (st.mtimeMs < horizonMs) {
          await unlink(p);
        }
      } catch {
        /* best-effort */
      }
    }
  }
}
