/**
 * Free-disk-space preflight for model downloads.
 *
 * On-device weights are the largest thing gezel ever writes: a llama.cpp Q4 is
 * a few GiB, but a ds4 GGUF is 80–200+ GiB. Without a preflight the failure
 * mode is the worst possible one — hours of download, then `ENOSPC` at 95%,
 * with a half-written `.partial` still occupying the disk it just filled.
 * Checking first turns that into one instant, actionable sentence.
 *
 * Two rules keep this from becoming its own failure source:
 *
 *   1. **Never block on unknown.** `statfs` is not available on every
 *      filesystem (network mounts, some container overlays). A check we
 *      couldn't perform returns `known: false` and callers proceed — a missing
 *      measurement must not stop a download that would have succeeded.
 *   2. **Measure the nearest existing ancestor.** The destination directory is
 *      usually created just before the download, but callers may preflight
 *      earlier; walking up to a directory that exists keeps the check honest
 *      instead of silently degrading to `known: false`.
 */

import { statfs } from 'node:fs/promises';
import { dirname } from 'node:path';

const GIB = 1024 ** 3;

/**
 * Headroom demanded on top of the download itself. A disk filled to the last
 * byte is a broken machine, not a successful install: macOS/Linux need free
 * space for swap, logs, and the atomic `.partial` → final rename. Scales with
 * the download so a 200 GiB model reserves proportionally more than a 4 GiB
 * one, with a 2 GiB floor for small models.
 */
export function requiredSlackBytes(downloadBytes: number): number {
  return Math.max(2 * GIB, Math.ceil(downloadBytes * 0.02));
}

export interface DiskSpaceCheck {
  /**
   * False when the filesystem couldn't be measured. `ok` is always true in
   * that case — callers must not treat an unmeasurable disk as a full one.
   */
  known: boolean;
  ok: boolean;
  freeBytes: number;
  /** Download size plus {@link requiredSlackBytes}. */
  requiredBytes: number;
}

/** Injectable for tests — the unmeasurable-filesystem branch can't be
 *  reproduced with a real path on a normal dev machine. */
export type StatfsImpl = (path: string) => Promise<{ bsize: number; bavail: number }>;

/**
 * Whether `dir`'s filesystem can hold `downloadBytes` more, plus headroom.
 *
 * `dir` need not exist yet — the nearest existing ancestor is measured, which
 * is the same filesystem in every layout gezel creates.
 */
export async function checkDiskSpace(
  dir: string,
  downloadBytes: number,
  statfsImpl: StatfsImpl = statfs,
): Promise<DiskSpaceCheck> {
  const requiredBytes = downloadBytes + requiredSlackBytes(downloadBytes);
  const freeBytes = await freeBytesFor(dir, statfsImpl);
  if (freeBytes === null) {
    return { known: false, ok: true, freeBytes: 0, requiredBytes };
  }
  return { known: true, ok: freeBytes >= requiredBytes, freeBytes, requiredBytes };
}

async function freeBytesFor(dir: string, statfsImpl: StatfsImpl): Promise<number | null> {
  let candidate = dir;
  for (let i = 0; i < 64; i++) {
    try {
      const st = await statfsImpl(candidate);
      // `bavail` (not `bfree`) is what an unprivileged process may actually
      // use — the difference is the root-reserved pool, which we can't have.
      return st.bsize * st.bavail;
    } catch {
      const parent = dirname(candidate);
      if (parent === candidate) return null;
      candidate = parent;
    }
  }
  return null;
}

/** One-sentence, user-facing shortfall message. Already friendly — callers
 *  surface it verbatim in an install-error banner. */
export function describeDiskShortfall(check: DiskSpaceCheck, what: string): string {
  const need = (check.requiredBytes / GIB).toFixed(1);
  const have = (check.freeBytes / GIB).toFixed(1);
  return `Not enough disk space for ${what}: needs about ${need} GB free (including working headroom), but this disk has ${have} GB. Free up space or choose a smaller model.`;
}
