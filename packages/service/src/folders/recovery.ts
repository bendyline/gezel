import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from '@bendyline/gezel';
import { foldersStateDir } from '@bendyline/gezel/paths';
import { writeFileAtomic } from '../fs/atomic.js';
import type { FolderScope } from './scope.js';

const log = createLogger('folders');

export interface ActiveMoveSentinel {
  jobId: string;
  scope: FolderScope;
  sourcePath: string;
  destPath: string;
  backupPath: string;
  startedAt: string;
}

function sentinelPath(home: string): string {
  return join(foldersStateDir(home), 'active-move.json');
}

export async function writeSentinel(home: string, sentinel: ActiveMoveSentinel): Promise<void> {
  const dir = foldersStateDir(home);
  await mkdir(dir, { recursive: true });
  await writeFileAtomic(sentinelPath(home), `${JSON.stringify(sentinel, null, 2)}\n`);
}

export async function clearSentinel(home: string): Promise<void> {
  try {
    await rm(sentinelPath(home));
  } catch {
    /* fine — already gone */
  }
}

export async function readSentinel(home: string): Promise<ActiveMoveSentinel | null> {
  try {
    const raw = await readFile(sentinelPath(home), 'utf8');
    return JSON.parse(raw) as ActiveMoveSentinel;
  } catch {
    return null;
  }
}

/** Called from service boot — surfaces a one-time warning if a previous
 *  move was interrupted. Doesn't auto-roll-back; the user gets a banner
 *  in the UI directing them to inspect `~/.gezel/backup/<ts>/` and reset
 *  the externalization in Settings → Folders. */
export async function detectInterruptedMove(home: string): Promise<ActiveMoveSentinel | null> {
  const sentinel = await readSentinel(home);
  if (!sentinel) return null;
  log.warn(
    `interrupted folder move detected (scope=${sentinel.scope}, source=${sentinel.sourcePath}, dest=${sentinel.destPath}, backup=${sentinel.backupPath}). Inspect the backup and reset the external folder in Settings → Folders.`,
  );
  return sentinel;
}
