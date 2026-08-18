import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { backupsDir } from '@bendyline/gezel/paths';
import { FOLDER_SCOPES, type FolderScope } from './scope.js';

/** One pre-move snapshot: a `<home>/backup/<ISO-timestamp>/` directory
 *  holding the filtered source tree of the scope(s) that were moved. */
export interface BackupSnapshot {
  /** Directory name under `<home>/backup/` — the sanitized timestamp. */
  id: string;
  path: string;
  /** Scopes snapshotted under this timestamp (usually exactly one). */
  scopes: FolderScope[];
  bytes: number;
  /** ISO timestamp recovered from the directory name; null when the
   *  name doesn't parse (hand-created or renamed folder). */
  createdAt: string | null;
}

export interface BackupSummary {
  count: number;
  totalBytes: number;
  path: string;
  /** Newest first. */
  snapshots: BackupSnapshot[];
}

/** The move worker names snapshot dirs `toISOString()` with `:` and `.`
 *  swapped for `-`, so the only way back is to put them where they were. */
const SNAPSHOT_ID = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/;

export function snapshotCreatedAt(id: string): string | null {
  const m = SNAPSHOT_ID.exec(id);
  if (!m) return null;
  const iso = `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export async function summarizeBackups(home: string): Promise<BackupSummary> {
  const root = backupsDir(home);
  let entries: string[] = [];
  try {
    entries = await readdir(root);
  } catch {
    return { count: 0, totalBytes: 0, path: root, snapshots: [] };
  }
  const snapshots: BackupSnapshot[] = [];
  let totalBytes = 0;
  for (const id of entries) {
    const path = join(root, id);
    let names: string[] = [];
    try {
      const st = await stat(path);
      if (!st.isDirectory()) continue;
      names = await readdir(path);
    } catch {
      continue;
    }
    const bytes = await dirSize(path);
    totalBytes += bytes;
    snapshots.push({
      id,
      path,
      scopes: FOLDER_SCOPES.filter((scope) => names.includes(scope)),
      bytes,
      createdAt: snapshotCreatedAt(id),
    });
  }
  // Snapshot ids are timestamps, so lexicographic descending is
  // chronological newest-first.
  snapshots.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  return { count: snapshots.length, totalBytes, path: root, snapshots };
}

async function dirSize(p: string): Promise<number> {
  let total = 0;
  let entries: string[] = [];
  try {
    entries = await readdir(p);
  } catch {
    return 0;
  }
  for (const name of entries) {
    const abs = join(p, name);
    try {
      const st = await stat(abs);
      if (st.isDirectory()) total += await dirSize(abs);
      else total += st.size;
    } catch {
      /* ignore */
    }
  }
  return total;
}
