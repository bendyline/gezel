import { randomUUID } from 'node:crypto';
import { type FileHandle, open, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

/**
 * Write a file atomically by writing to a sibling tmp path and then
 * renaming over the target. `rename` is atomic on NTFS, ext4, and
 * APFS from the application's perspective — readers see either the
 * previous file or the new one, never an in-between zeroed file.
 *
 * The fix this exists for: a plain `fs.writeFile` truncates + extends
 * the target file's size on disk independently of the data flush. A
 * power loss or force-kill between the size extension and the actual
 * data write leaves a file whose on-disk size says N bytes but whose
 * contents are all-NUL — which `JSON.parse` then chokes on with
 * `Unexpected token '' is not valid JSON`. Writing to a tmp file
 * first means the target path is never in that intermediate state.
 *
 * Accepts strings (treated as utf8) and binary `Uint8Array` / `Buffer`
 * payloads. Callers that previously used `writeFile(p, data)` (no
 * encoding arg, binary data) can swap in `writeFileAtomic(p, data)`
 * with no other change.
 *
 * `durable: true` additionally fsyncs the staged file before rename and,
 * where the platform supports it, the parent directory afterward. Use it for
 * recovery journals and ownership markers whose survival across power loss is
 * required to decide whether later cleanup is safe.
 *
 * The tmp name includes pid + a random suffix so concurrent writers
 * (multiple gezeld processes, or two threads in the same process)
 * don't collide on the same staging path. On rename failure we try
 * to unlink the orphaned tmp; that's best-effort because a partial
 * tmp is harmless — the next write will pick a fresh name.
 *
 * NOT used for:
 *   - append-only logs (HistoryManager's `history.jsonl`, daily
 *     memory markdown) — those use `appendFile` by design and don't
 *     suffer the truncate-extend race
 *   - native binary trees / extracted runtimes (supervisor-owned)
 *   - sandboxed script outputs and other external working copies
 *
 * See CLAUDE.md "Don't bypass the Store" / carve-outs section for
 * the canonical list of paths that opt out of this contract.
 */
export async function writeFileAtomic(
  absPath: string,
  content: string | Uint8Array,
  opts?: { mode?: number; durable?: boolean },
): Promise<void> {
  const tmp = `${absPath}.tmp-${process.pid}-${randomUUID()}`;
  // When a mode is given (secret files), create the tmp with it so the
  // file is never group/world-readable even momentarily — the prior
  // "write at umask, chmod 0600 afterwards" pattern left a TOCTOU window
  // in which a local watcher could open the still-0644 file. `rename`
  // preserves the tmp's mode, so the published target lands at `mode`.
  const modeOpt = opts?.mode !== undefined ? { mode: opts.mode } : {};
  try {
    if (typeof content === 'string') {
      await writeFile(tmp, content, { encoding: 'utf8', ...modeOpt });
    } else {
      await writeFile(tmp, content, modeOpt);
    }
    if (opts?.durable) await fsyncPath(tmp);
    await renameWithWindowsRetry(tmp, absPath);
    if (opts?.durable) await fsyncDirectoryIfSupported(dirname(absPath));
  } catch (err) {
    try {
      await rm(tmp, { force: true });
    } catch {
      // ignore — leftover tmp is harmless
    }
    throw err;
  }
}

async function fsyncPath(path: string): Promise<void> {
  // Windows requires a handle opened with write access for FlushFileBuffers;
  // POSIX accepts the same mode for fsync(2).
  const handle = await open(path, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * POSIX needs the containing directory synced for the rename itself to survive
 * power loss. Windows does not consistently permit opening directories as
 * file handles; the file flush above is still honored there and unsupported
 * directory-sync errors are ignored.
 */
async function fsyncDirectoryIfSupported(path: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, 'r');
    await handle.sync();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (
      process.platform === 'win32' &&
      (code === 'EACCES' || code === 'EINVAL' || code === 'ENOTSUP' || code === 'EPERM')
    ) {
      return;
    }
    throw err;
  } finally {
    await handle?.close();
  }
}

/**
 * `rename` retry loop for Windows. On POSIX filesystems rename is
 * straightforwardly atomic and the first call succeeds; on Windows
 * (NTFS) it can fail transiently with `EPERM` / `EACCES` / `EBUSY`
 * when something else briefly holds the target file open — Windows
 * Defender's real-time scan is the most common culprit, but the
 * Search indexer, IDE file watchers, or backup utilities can do it
 * too. The lock window is typically tens of milliseconds.
 *
 * Strategy: try the rename, and on a transient error retry up to
 * `maxAttempts` times with exponential backoff (10ms, 20ms, 40ms,
 * 80ms, 160ms — total ~310ms worst case before giving up). Any
 * non-transient error (ENOENT, EROFS, etc.) fails fast on the
 * first attempt. POSIX never enters the retry path because the
 * first rename succeeds.
 *
 * Without this, `writeFileAtomic` flakes on Windows under typical
 * developer environments (AV running, IDE watching). The plain
 * `fs.writeFile` it replaced didn't have this problem because it
 * doesn't rename — but it ALSO doesn't survive crashes, which is
 * the whole reason this helper exists. Retry restores that
 * tradeoff on the platform where it costs the most.
 */
async function renameWithWindowsRetry(from: string, to: string): Promise<void> {
  const maxAttempts = 6;
  let delayMs = 10;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const transient = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
      if (!transient || attempt === maxAttempts) throw err;
      await sleep(delayMs);
      delayMs *= 2;
    }
  }
}
