import { existsSync } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { type FolderCensus, isDocumentFileName } from '@bendyline/gezel';
import { classifyFile } from '../index-store/classify.js';
import { isSkippedDir, looksCloudOnly } from '../workspace/file-walk.js';

/** Files a census looks at before it reports a partial count. */
const CENSUS_MAX_FILES = 60_000;
/** Wall-clock budget for one folder; onboarding waits on it. */
const CENSUS_BUDGET_MS = 2_500;
const CENSUS_TTL_MS = 60_000;

const cache = new Map<string, { at: number; census: FolderCensus }>();

/**
 * What a folder holds, for the onboarding and add-folder cards: "12,480
 * photos · 1,204 only in iCloud". A bounded recursive walk with the indexer's
 * skip rules; stat only, so nothing is read and no cloud file downloads.
 * `complete: false` means the counts stopped at the file or time budget.
 */
export async function censusFolder(
  dir: string,
  opts: { maxFiles?: number; budgetMs?: number; now?: () => number } = {},
): Promise<FolderCensus> {
  const now = opts.now ?? Date.now;
  const hit = cache.get(dir);
  if (hit && now() - hit.at < CENSUS_TTL_MS) return hit.census;
  const maxFiles = opts.maxFiles ?? CENSUS_MAX_FILES;
  const deadline = now() + (opts.budgetMs ?? CENSUS_BUDGET_MS);
  const census: FolderCensus = {
    files: 0,
    images: 0,
    videos: 0,
    documents: 0,
    cloudOnly: 0,
    complete: true,
  };
  let newest = 0;
  const stack = [dir];
  while (stack.length > 0) {
    if (census.files >= maxFiles || now() > deadline) {
      census.complete = false;
      break;
    }
    const current = stack.pop()!;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const abs = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!isSkippedDir(entry.name)) stack.push(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      if (census.files >= maxFiles) {
        census.complete = false;
        break;
      }
      let st: import('node:fs').Stats;
      try {
        st = await lstat(abs);
      } catch {
        continue;
      }
      census.files++;
      newest = Math.max(newest, st.mtimeMs);
      if (looksCloudOnly(st)) census.cloudOnly++;
      const modality = classifyFile(entry.name, st.size).modality;
      if (modality === 'image') census.images++;
      else if (modality === 'video') census.videos++;
      else if (isDocumentFileName(entry.name)) census.documents++;
    }
  }
  if (newest > 0) census.newestMtime = new Date(newest).toISOString();
  cache.set(dir, { at: now(), census });
  return census;
}

/** Where developers keep their checkouts, relative to the home folder. */
const CODE_ROOTS = ['code', 'src', 'Projects', 'Developer', 'GitHub', 'gh', 'repos', 'dev', 'git'];
const MAX_CODE_FOLDERS = 24;

/**
 * Git checkouts at most two levels under the usual code roots in the home
 * folder (`~/code/app`, `~/gh/org/app`), for "Add your code too?" offers.
 */
export async function findCodeFolders(homedir: string): Promise<string[]> {
  const found: string[] = [];
  const consider = async (dir: string, depth: number): Promise<void> => {
    if (found.length >= MAX_CODE_FOLDERS) return;
    if (existsSync(join(dir, '.git'))) {
      found.push(dir);
      return;
    }
    if (depth === 0) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || isSkippedDir(entry.name)) continue;
      await consider(join(dir, entry.name), depth - 1);
      if (found.length >= MAX_CODE_FOLDERS) return;
    }
  };
  for (const root of CODE_ROOTS) {
    const dir = join(homedir, root);
    if (!existsSync(dir)) continue;
    // The root itself is a container, not a checkout someone would add.
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      await consider(join(dir, entry.name), 1);
      if (found.length >= MAX_CODE_FOLDERS) break;
    }
  }
  return found;
}
