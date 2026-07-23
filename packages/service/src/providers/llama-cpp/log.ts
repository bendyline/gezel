import { type WriteStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { redactLogLine } from './log-redact.js';

/**
 * Rolling append-only log for llama-server stdout/stderr. Mirrors the
 * per-day pattern in packages/app/src/supervisor/log-rotator.ts but
 * lives inside the service package so the Electron → service
 * dependency direction stays one-way.
 *
 * Files live at `<dir>/llama-server-YYYY-MM-DD.log`, roll to
 * `-1.log` / `-2.log` when the active file crosses 10 MB, and ones
 * older than 7 days are swept on open.
 *
 * Design note: we duplicate (rather than factor-out) the small
 * rotator because the alternative is a shared package. Two files of
 * trivial rotation logic is cheaper than a new package boundary for
 * the size of this codebase.
 */
export class LlamaCppLogFile {
  private stream: WriteStream | null = null;
  private currentPath: string | null = null;
  private currentDay: string | null = null;
  private rollIndex = 0;
  private bytesWritten = 0;
  private readonly maxBytes = 10 * 1024 * 1024;
  private readonly retentionDays = 7;
  private readonly readyPromise: Promise<void>;
  private pendingWrites: Promise<void> = Promise.resolve();

  constructor(
    private readonly dir: string,
    private readonly baseName = 'llama-server',
  ) {
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
    const base = join(this.dir, `${this.baseName}-${this.currentDay}.log`);
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
    const rolled = join(this.dir, `${this.baseName}-${this.currentDay}-${this.rollIndex}.log`);
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
    // Credential-shape scrub before hitting disk. See `log-redact.ts`
    // for the patterns + rationale. Defense in depth — llama-server
    // doesn't emit secrets by design, but a log file is the kind of
    // thing users share on bug reports, and being wrong-by-omission
    // here costs more than over-redacting.
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

  /** Wait for all in-flight writes to flush, then return. */
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
   * Read the last `bytes` chars of the current file. Used by the
   * Settings → On-device → Engine log disclosure. Returns an empty
   * string if the file doesn't exist yet (first launch, nothing
   * logged).
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
      if (!name.startsWith(`${this.baseName}-`) || !name.endsWith('.log')) continue;
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

/**
 * Read the newest retained engine log without constructing a writer. This is
 * used by diagnostics after the provider has been evicted or the app was
 * force-quit — exactly when an in-memory provider handle is unavailable but
 * the last native stdout/stderr is most useful.
 */
export async function tailLatestEngineLog(
  dir: string,
  baseName: string,
  bytes: number,
): Promise<{ path: string | null; tail: string }> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return { path: null, tail: '' };
  }

  const candidates = await Promise.all(
    names
      .filter((name) => name.startsWith(`${baseName}-`) && name.endsWith('.log'))
      .map(async (name) => {
        const path = join(dir, name);
        try {
          return { path, mtimeMs: (await stat(path)).mtimeMs };
        } catch {
          return null;
        }
      }),
  );
  const latest = candidates
    .filter((entry): entry is { path: string; mtimeMs: number } => entry !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
  if (!latest) return { path: null, tail: '' };

  try {
    const content = await readFile(latest.path, 'utf8');
    return {
      path: latest.path,
      tail: content.length <= bytes ? content : content.slice(content.length - bytes),
    };
  } catch {
    return { path: latest.path, tail: '' };
  }
}
