/**
 * Read a text file's lines last-first, one chunk at a time.
 *
 * History files are append-only and stamped in append order, so a query bounded
 * by time or count only needs the end of the file. Streaming every line forward
 * to find the last few minutes cost a media collection two parses of an 845 MB
 * log per completion-gate check (2026-10-26): `advance_task_step` took 86 s while
 * the model had worked for 20, and the Codex slot waited the whole time.
 *
 * Lines are split on the newline byte, which never occurs inside a UTF-8
 * multibyte sequence, so a chunk boundary cannot split a character. The size is
 * read once when the file is opened. Bytes appended afterwards are not
 * returned, and an atomic rewrite keeps serving the inode that was opened.
 */
import { open } from 'node:fs/promises';

const NEWLINE = 0x0a;
export const BACKWARD_CHUNK_BYTES = 1 << 20;

export async function* readLinesBackward(
  path: string,
  chunkBytes = BACKWARD_CHUNK_BYTES,
): AsyncGenerator<string> {
  const handle = await open(path, 'r');
  try {
    let position = (await handle.stat()).size;
    let carry: Buffer | null = null;
    while (position > 0) {
      const length = Math.min(chunkBytes, position);
      position -= length;
      const chunk = Buffer.allocUnsafe(length);
      let filled = 0;
      while (filled < length) {
        const { bytesRead } = await handle.read(chunk, filled, length - filled, position + filled);
        // Truncated underneath us: what was read no longer lines up with the
        // bytes after it, so stop rather than splice unrelated text together.
        if (bytesRead === 0) return;
        filled += bytesRead;
      }
      const buffer: Buffer = carry ? Buffer.concat([chunk, carry]) : chunk;
      let end = buffer.length;
      while (end > 0) {
        const newline = buffer.lastIndexOf(NEWLINE, end - 1);
        if (newline < 0) break;
        if (end > newline + 1) yield buffer.toString('utf8', newline + 1, end);
        end = newline;
      }
      carry = end > 0 ? buffer.subarray(0, end) : null;
    }
    if (carry) yield carry.toString('utf8');
  } finally {
    await handle.close();
  }
}
