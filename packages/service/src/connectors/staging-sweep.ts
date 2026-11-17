/**
 * Connector passes stage downloads in private folders under the OS temp
 * directory and remove them when the pass ends. A daemon that stops mid-pass
 * (a crash, a quit, a power loss) leaves them behind, and a Drive or release
 * backfill can leave gigabytes. At boot, folders with a connector prefix that
 * nothing has touched for a while are removed.
 */

import type { Dirent } from 'node:fs';
import { readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '@bendyline/gezel';

const log = createLogger('connectors');

/** Every staging prefix a connector creates (`mkdtemp` appends a random suffix). */
export const CONNECTOR_STAGING_PREFIXES = [
  'gezel-drive-files-',
  'gezel-graph-files-',
  'gezel-github-releases-',
  'gezel-github-wiki-',
  'gezel-spectral-',
] as const;

/**
 * Old enough that no live pass can own it: a pass is stopped by its watchdog
 * after 30 minutes, and another daemon of the same account (an app's own
 * home) shares the temp directory.
 */
const STALE_AFTER_MS = 6 * 60 * 60_000;

export async function sweepConnectorStaging(
  opts: { dir?: string; now?: number; staleAfterMs?: number } = {},
): Promise<number> {
  const dir = opts.dir ?? tmpdir();
  const now = opts.now ?? Date.now();
  const staleAfter = opts.staleAfterMs ?? STALE_AFTER_MS;
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!CONNECTOR_STAGING_PREFIXES.some((p) => entry.name.startsWith(p))) continue;
    const path = join(dir, entry.name);
    try {
      const info = await stat(path);
      if (now - info.mtimeMs < staleAfter) continue;
      await rm(path, { recursive: true, force: true });
      removed++;
    } catch {
      // Another process removed it, or it is not ours to remove.
    }
  }
  if (removed > 0) log.info(`removed ${removed} staging folder(s) left by interrupted syncs`);
  return removed;
}
