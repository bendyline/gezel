import { fstatSync } from 'node:fs';
import { CliError } from './connection.js';

/** What stdin is attached to, as far as `gezel run` cares. */
export type StdinKind = 'tty' | 'file' | 'pipe' | 'none';

/** How long a pipe may stay silent before `gezel run "<prompt>"` goes on without it. */
export const PIPED_FIRST_DATA_MS = 200;

type RunInput = AsyncIterable<string | Buffer> & { isTTY?: boolean };

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFIFO = 0o010000;
const S_IFSOCK = 0o140000;

/**
 * Classify fd 0 by its mode bits. `Stats.isFIFO()` is false for every pipe
 * on Windows, where Node defines no S_IFIFO, though libuv reports the bits.
 * A character device that is not a terminal (`/dev/null`, Windows `NUL`, a
 * child started with stdin ignored) delivers nothing, so it is never read.
 */
export function detectStdinKind(
  stat: (fd: number) => { mode: number } = fstatSync,
  isTTY: boolean | undefined = process.stdin.isTTY,
): StdinKind {
  if (isTTY) return 'tty';
  let type: number;
  try {
    type = stat(0).mode & S_IFMT;
  } catch {
    return 'none';
  }
  if (type === S_IFREG) return 'file';
  if (type === S_IFIFO || type === S_IFSOCK) return 'pipe';
  return 'none';
}

/**
 * The prompt `gezel run` sends. A sole `-` reads all of stdin. Words are the
 * prompt; when stdin is a file or a pipe that delivers text, a blank line and
 * that text follow it, so `gezel run "Summarize this" < notes.txt` sends the
 * notes too. WHY: that text used to be dropped without a word (2026-11-11 npm
 * ship audit). A terminal is never read, and a pipe that sends nothing within
 * {@link PIPED_FIRST_DATA_MS} is left alone, so a caller that leaves stdin
 * open never hangs the run.
 */
export async function resolveRunPrompt(
  parts: string[] | undefined,
  input: RunInput = process.stdin,
  options: { stdinKind?: StdinKind; firstDataMs?: number } = {},
): Promise<string> {
  if (parts?.length !== 1 || parts[0] !== '-') {
    const prompt = (parts ?? []).join(' ').trim();
    if (!prompt) throw new CliError('usage: gezel run "<prompt>" or gezel run -');
    const kind =
      options.stdinKind ??
      (input === process.stdin ? detectStdinKind() : input.isTTY ? 'tty' : 'none');
    if (kind !== 'file' && kind !== 'pipe') return prompt;
    const piped = await readPiped(
      input,
      kind === 'pipe' ? (options.firstDataMs ?? PIPED_FIRST_DATA_MS) : undefined,
    );
    return piped?.trim() ? `${prompt}\n\n${piped}` : prompt;
  }

  if (input.isTTY) {
    throw new CliError('gezel run - requires piped input or a redirected file.');
  }

  const prompt = await readAll(input);
  if (!prompt.trim())
    throw new CliError('gezel run - received empty input. Supply a prompt on stdin.');
  return prompt;
}

async function readAll(input: RunInput): Promise<string> {
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of input) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
  } catch (error) {
    throw new CliError(
      `Could not read prompt from stdin: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Read `input` to its end, or give up with `undefined` when nothing arrives
 * within `firstDataMs`. Once the first chunk arrives the rest is read in full.
 * Giving up pauses the stream and lets go of it, so it does not hold the
 * process open.
 */
async function readPiped(
  input: RunInput,
  firstDataMs: number | undefined,
): Promise<string | undefined> {
  const iterator = input[Symbol.asyncIterator]();
  let first: IteratorResult<string | Buffer>;
  try {
    if (firstDataMs === undefined) {
      first = await iterator.next();
    } else {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const silent = new Promise<'silent'>((resolve) => {
        timer = setTimeout(() => resolve('silent'), firstDataMs);
      });
      const next = iterator.next();
      const result = await Promise.race([next, silent]).finally(() => clearTimeout(timer));
      if (result === 'silent') {
        // A pending read keeps a pipe flowing; let it settle unobserved.
        next.catch(() => {});
        letGo(input);
        return undefined;
      }
      first = result;
    }
  } catch (error) {
    throw new CliError(
      `Could not read the piped text from stdin: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (first.done) return undefined;
  const chunks: Buffer[] = [toBuffer(first.value)];
  try {
    for (let next = await iterator.next(); !next.done; next = await iterator.next()) {
      chunks.push(toBuffer(next.value));
    }
  } catch (error) {
    throw new CliError(
      `Could not read the piped text from stdin: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return Buffer.concat(chunks).toString('utf8');
}

function toBuffer(chunk: string | Buffer): Buffer {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
}

function letGo(input: RunInput): void {
  const stream = input as { pause?: () => unknown; unref?: () => unknown };
  stream.pause?.();
  stream.unref?.();
}
