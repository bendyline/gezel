import { type WriteStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export interface LogRotatorOptions {
  dir: string;
  /** Max bytes per file before rolling. Defaults to 10 MB. */
  maxBytes?: number;
  /** Retention in days — files older than this are deleted. Defaults to 7. */
  retentionDays?: number;
}

/**
 * Append-only log writer for the spawned gezeld child's stdout/stderr and
 * Electron supervisor diagnostics that must survive an unattended failure.
 *
 * - Files live at `<dir>/service-YYYY-MM-DD.log`.
 * - Rolls to `-1.log`, `-2.log`, … when the active file exceeds `maxBytes`.
 * - On construction, sweeps files older than `retentionDays` out of `dir`.
 *
 * Deliberately small — no zstd, no rotation-on-signal, no compression. The
 * child already logs lines to its own stderr too (pino); this is just a
 * durable record for "what was gezeld doing at 3am last Tuesday."
 */
export class LogRotator {
  private stream: WriteStream | null = null;
  private currentPath: string | null = null;
  private currentDay: string | null = null;
  private rollIndex = 0;
  private bytesWritten = 0;
  private readonly maxBytes: number;
  private readonly retentionDays: number;
  private readyPromise: Promise<void>;

  constructor(private opts: LogRotatorOptions) {
    this.maxBytes = opts.maxBytes ?? 10 * 1024 * 1024;
    this.retentionDays = opts.retentionDays ?? 7;
    this.readyPromise = this.init();
  }

  private async init(): Promise<void> {
    await mkdir(this.opts.dir, { recursive: true });
    await this.sweepOldFiles();
    await this.openForToday();
  }

  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private async openForToday(): Promise<void> {
    this.currentDay = this.today();
    this.rollIndex = 0;
    const base = join(this.opts.dir, `service-${this.currentDay}.log`);
    // Pick up the existing bytes count if the file already exists so we
    // don't overshoot maxBytes across restarts.
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
    // Roll: close current, open service-YYYY-MM-DD-<n>.log.
    await this.close();
    this.rollIndex += 1;
    const rolled = join(this.opts.dir, `service-${this.currentDay}-${this.rollIndex}.log`);
    this.currentPath = rolled;
    this.bytesWritten = 0;
    this.stream = createWriteStream(rolled, { flags: 'a' });
  }

  async write(line: string): Promise<void> {
    await this.readyPromise;
    await this.rollIfNeeded();
    if (!this.stream) return;
    const buf = Buffer.from(line.endsWith('\n') ? line : `${line}\n`, 'utf8');
    await new Promise<void>((resolve) => {
      this.stream!.write(buf, () => resolve());
    });
    this.bytesWritten += buf.length;
  }

  async close(): Promise<void> {
    if (!this.stream) return;
    const s = this.stream;
    this.stream = null;
    await new Promise<void>((resolve) => s.end(() => resolve()));
  }

  private async sweepOldFiles(): Promise<void> {
    const horizonMs = Date.now() - this.retentionDays * 24 * 60 * 60 * 1000;
    let entries: string[];
    try {
      entries = await readdir(this.opts.dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (!name.startsWith('service-') || !name.endsWith('.log')) continue;
      const p = join(this.opts.dir, name);
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
