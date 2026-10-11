/**
 * Script RPC over the standard pipes, for sandboxes that pass no handle
 * beyond stdin/stdout/stderr (Windows MXC). The fd-3 protocol's frames are
 * unchanged; only the carriage differs:
 *
 *   - host -> script: the init message is the first line of stdin, and
 *     replies follow on stdin, which stays open for the whole run.
 *   - script -> host: each frame goes to stdout behind a per-run marker, so
 *     text the script prints (fetched pages, user data) is never read as a
 *     call unless it carries a nonce only the run's environment knows.
 *
 * The marker shape must match `packages/sdk/src/rpc.ts`.
 */
import { randomBytes } from 'node:crypto';

export const STDIO_RPC_ENV = 'GEZEL_SCRIPT_RPC';
export const STDIO_RPC_NONCE_ENV = 'GEZEL_SCRIPT_RPC_NONCE';

/**
 * Largest single RPC message the daemon will buffer, on either transport. No
 * smaller limit exists on what a script may write through `gezel.fs.write`,
 * so this bounds the daemon's memory rather than any one call's payload.
 */
export const MAX_RPC_FRAME_CHARS = 64 * 1024 * 1024;

export class StdioRpcOverflowError extends Error {}

export function newStdioRpcNonce(): string {
  return randomBytes(16).toString('hex');
}

export function stdioRpcMarker(nonce: string): string {
  return `\u001egezel-rpc:${nonce}:`;
}

/** The init message as one line: JSON.stringify never emits a raw newline. */
export function stdioRpcInitLine(input: string): string {
  try {
    return `${JSON.stringify(JSON.parse(input))}\n`;
  } catch {
    return `${input.replace(/\r?\n/g, ' ')}\n`;
  }
}

/**
 * Splits a script's stdout into ordinary output and RPC frames. A frame may
 * start mid-line (an unterminated `process.stdout.write` before a call) and
 * may arrive split across chunks; anything that could still become a marker
 * is held back until the next chunk decides it.
 */
export class StdioRpcDemuxer {
  private readonly marker: string;
  private readonly maxPending: number;
  private pending = '';
  /** `pending` starts with a frame whose newline has not arrived yet. */
  private frameOpen = false;

  constructor(nonce: string, maxPending = MAX_RPC_FRAME_CHARS) {
    this.marker = stdioRpcMarker(nonce);
    this.maxPending = maxPending;
  }

  /** Throws {@link StdioRpcOverflowError} when an unfinished frame grows past the cap. */
  push(chunk: string): { text: string; frames: string[] } {
    // A large frame arrives in many chunks; resume the newline search where
    // the last one stopped instead of rescanning the whole frame each time.
    let resumeAt = this.frameOpen ? this.pending.length : -1;
    this.frameOpen = false;
    this.pending += chunk;
    let text = '';
    const frames: string[] = [];
    for (;;) {
      const start = resumeAt >= 0 ? 0 : this.pending.indexOf(this.marker);
      if (start < 0) break;
      const end = this.pending.indexOf('\n', resumeAt >= 0 ? resumeAt : start + this.marker.length);
      resumeAt = -1;
      if (end < 0) {
        text += this.pending.slice(0, start);
        this.pending = this.pending.slice(start);
        if (this.pending.length > this.maxPending) {
          this.pending = '';
          throw new StdioRpcOverflowError('script RPC frame exceeded the size cap');
        }
        this.frameOpen = true;
        return { text, frames };
      }
      text += this.pending.slice(0, start);
      frames.push(this.pending.slice(start + this.marker.length, end));
      this.pending = this.pending.slice(end + 1);
    }
    const hold = partialMarkerSuffix(this.pending, this.marker);
    text += this.pending.slice(0, this.pending.length - hold);
    this.pending = this.pending.slice(this.pending.length - hold);
    return { text, frames };
  }

  /** Whatever is left when the script exits, an unfinished frame included. */
  flush(): string {
    const rest = this.pending;
    this.pending = '';
    this.frameOpen = false;
    return rest;
  }
}

function partialMarkerSuffix(text: string, marker: string): number {
  const max = Math.min(text.length, marker.length - 1);
  for (let len = max; len > 0; len--) {
    if (marker.startsWith(text.slice(text.length - len))) return len;
  }
  return 0;
}
