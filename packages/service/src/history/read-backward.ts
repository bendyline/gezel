/**
 * Read a text file's lines last-first, one chunk at a time.
 *
 * History files are append-only and stamped in append order, so a query bounded
 * by time or count only needs the end of the file. Streaming every line forward
 * to find the last few minutes cost a media collection two parses of an 845 MB
 * log per completion-gate check (2026-10-26): `advance_task_step` took 86 s while
 * the model had worked for 20, and the Codex slot waited the whole time.
 *
 * A query for one task's events can reach back days for a handful of lines, so
 * `readMatchingLinesBackward` looks for the text in the raw bytes and decodes
 * only the lines that hold it. Resuming 42 tasks held for 13 days decoded
 * 1.25 GB each on the daemon's one thread (2026-11-23): completions took ten
 * minutes and every turn hit its 180 s limit.
 *
 * Lines are split on the newline byte, which never occurs inside a UTF-8
 * multibyte sequence, so a chunk boundary cannot split a character. The size is
 * read once when the file is opened. Bytes appended afterwards are not
 * returned, and an atomic rewrite keeps serving the inode that was opened.
 */
import { open } from 'node:fs/promises';

const NEWLINE = 0x0a;
export const BACKWARD_CHUNK_BYTES = 1 << 20;
/** Enough of a line's start to hold its first fields, whatever the line's length. */
const LINE_START_BYTES = 512;

/**
 * Whole lines, a chunk's worth at a time, last region first. One buffer is
 * reused throughout, so a region is valid only until the next is asked for.
 */
async function* readRegionsBackward(path: string, chunkBytes: number): AsyncGenerator<Buffer> {
  const handle = await open(path, 'r');
  try {
    let position = (await handle.stat()).size;
    let buffer = Buffer.allocUnsafe(chunkBytes);
    // Bytes at the start of `buffer` that end a line begun in an earlier chunk.
    let carried = 0;
    while (position > 0) {
      const length = Math.min(chunkBytes, position);
      const end = length + carried;
      if (end > buffer.length) {
        const larger = Buffer.allocUnsafe(Math.max(end, buffer.length * 2));
        buffer.copy(larger, length, 0, carried);
        buffer = larger;
      } else buffer.copyWithin(length, 0, carried);
      position -= length;
      let filled = 0;
      while (filled < length) {
        const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
        // Truncated underneath us: what was read no longer lines up with the
        // bytes after it, so stop rather than splice unrelated text together.
        if (bytesRead === 0) return;
        filled += bytesRead;
      }
      if (position === 0) {
        yield buffer.subarray(0, end);
        return;
      }
      // The carried bytes hold no newline, so only the new ones are searched.
      const newline = buffer.subarray(0, length).indexOf(NEWLINE);
      carried = newline < 0 ? end : newline;
      if (newline >= 0 && newline + 1 < end) yield buffer.subarray(newline + 1, end);
    }
  } finally {
    await handle.close();
  }
}

export async function* readLinesBackward(
  path: string,
  chunkBytes = BACKWARD_CHUNK_BYTES,
): AsyncGenerator<string> {
  for await (const region of readRegionsBackward(path, chunkBytes)) {
    let end = region.length;
    while (end > 0) {
      const newline = region.lastIndexOf(NEWLINE, end - 1);
      if (end > newline + 1) yield region.toString('utf8', newline + 1, end);
      end = newline;
    }
  }
}

/**
 * The lines that contain `text`, last-first. `text` must not span lines.
 *
 * `isPast` is shown the start of the oldest line in each chunk once that chunk's
 * matches have been yielded; returning true ends the read. It is how a search
 * that matches nothing still stops at its bound, so the caller also checks each
 * line it is given.
 */
export async function* readMatchingLinesBackward(
  path: string,
  text: string,
  isPast: (lineStart: string) => boolean = () => false,
  chunkBytes = BACKWARD_CHUNK_BYTES,
): AsyncGenerator<string> {
  const needle = Buffer.from(text, 'utf8');
  if (needle.length === 0 || needle.includes(NEWLINE)) {
    throw new Error('A backward line search needs text within one line');
  }
  for await (const region of readRegionsBackward(path, chunkBytes)) {
    // Forward, because a backward search has no fast path here: the matches of
    // one chunk are collected, then yielded newest first.
    const matches: Array<{ start: number; end: number }> = [];
    let from = 0;
    while (from < region.length) {
      const found = region.indexOf(needle, from);
      if (found < 0) break;
      const newline = region.indexOf(NEWLINE, found + needle.length);
      const end = newline < 0 ? region.length : newline;
      matches.push({ start: region.lastIndexOf(NEWLINE, found) + 1, end });
      from = end + 1;
    }
    for (const { start, end } of matches.reverse()) yield region.toString('utf8', start, end);
    if (isPast(region.toString('utf8', 0, Math.min(LINE_START_BYTES, region.length)))) return;
  }
}
