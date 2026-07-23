import { createReadStream } from 'node:fs';
import { appendFile, mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';

/**
 * Per-trial logger. Writes a human-readable timeline to `<runDir>/log.txt`
 * with millisecond-precision timestamps, and tails `<gezelHome>/history.jsonl`
 * in the background — appending each new event as a one-line summary to the
 * log AND mirroring the raw line into `<runDir>/history.jsonl` for postmortem.
 *
 * The history tail uses a byte-offset stream rather than re-reading the file
 * so a busy trial doesn't churn through megabytes of audit log every poll.
 */
export class TrialLogger {
  private logPath: string;
  private historyMirrorPath: string;
  private historySrc: string;
  private offset = 0;
  private stopped = false;
  private readonly tickMs: number;
  private tailLoop?: Promise<void>;

  constructor(opts: { runDir: string; gezelHome: string; tickMs?: number }) {
    this.logPath = join(opts.runDir, 'log.txt');
    this.historyMirrorPath = join(opts.runDir, 'history.jsonl');
    this.historySrc = join(opts.gezelHome, 'history.jsonl');
    this.tickMs = opts.tickMs ?? 1000;
  }

  async init(): Promise<void> {
    await mkdir(dirname(this.logPath), { recursive: true });
    await appendFile(this.logPath, ''); // create empty file
    await appendFile(this.historyMirrorPath, '');
  }

  log = (line: string): void => {
    const ts = new Date().toISOString();
    const text = `[${ts}] ${line}\n`;
    // Best-effort fire-and-forget — we don't want a slow disk to hold up
    // the runner's poll loop. Errors are surfaced on close.
    appendFile(this.logPath, text).catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[evals] log write failed:', err);
    });
    process.stdout.write(text);
  };

  startHistoryTail(): void {
    if (this.tailLoop) return;
    this.tailLoop = this.tailHistoryForever();
  }

  private async tailHistoryForever(): Promise<void> {
    while (!this.stopped) {
      try {
        const st = await stat(this.historySrc).catch(() => null);
        if (st && st.size > this.offset) {
          await this.drainHistory(st.size);
        }
      } catch (err) {
        this.log(`[history-tail] error: ${err instanceof Error ? err.message : String(err)}`);
      }
      await wait(this.tickMs);
    }
    // Final drain after stop, in case events landed between the last tick
    // and shutdown.
    const st = await stat(this.historySrc).catch(() => null);
    if (st && st.size > this.offset) await this.drainHistory(st.size);
  }

  private async drainHistory(sizeNow: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const stream = createReadStream(this.historySrc, {
        start: this.offset,
        end: sizeNow - 1,
      });
      let buf = '';
      stream.on('data', (chunk) => {
        buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      });
      stream.on('end', async () => {
        const lines = buf.split('\n').filter((l) => l.trim());
        for (const line of lines) {
          try {
            await appendFile(this.historyMirrorPath, `${line}\n`);
            const summary = summarizeHistoryLine(line);
            if (summary) this.log(`[history] ${summary}`);
          } catch {
            // ignore — best effort
          }
        }
        this.offset = sizeNow;
        resolve();
      });
      stream.on('error', reject);
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.tailLoop) await this.tailLoop;
  }
}

/**
 * Render a single history.jsonl line into a one-line human summary. Returns
 * null for entries we don't have a summary for — the raw JSON is still
 * written to the mirror file, so nothing is lost.
 */
function summarizeHistoryLine(line: string): string | null {
  let evt: Record<string, unknown>;
  try {
    evt = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  const kind = String(evt.kind ?? '');
  if (!kind) return null;
  const tail: string[] = [];
  for (const k of ['gezelId', 'projectId', 'taskId', 'tool', 'status', 'name']) {
    if (typeof evt[k] === 'string' && (evt[k] as string).length > 0) {
      tail.push(`${k}=${evt[k] as string}`);
    }
  }
  return tail.length ? `${kind} ${tail.join(' ')}` : kind;
}
