import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { systemToolsetsFile } from '@bendyline/gezel/paths';
import { writeFileAtomic } from '../fs/atomic.js';

/**
 * Tracking record for what's been installed at the system scope.
 *
 * This is **separate** from the `InstalledToolset[]` list (which carries
 * `installPath` + `runtime`) — this file records the *pinned* version +
 * integrity so the bootstrap can tell at a glance whether the shipped
 * manifest has moved and an install needs to run. Keeping the two files
 * distinct means we can re-derive one from the other if either drifts.
 */
export interface SystemTrackingEntry {
  toolsetId: string;
  version: string;
  integrity: string;
  installedAt: string;
}

export interface SystemTrackingRecord {
  /** The bundled pnpm version at the time of the last install (if any). */
  pnpmVersion?: string;
  /** Chromium revision currently on disk (matches `CHROMIUM_REVISION` when fresh). */
  chromiumRevision?: string;
  /** Per-toolset record, keyed by toolsetId. */
  toolsets: Record<string, SystemTrackingEntry>;
  updatedAt: string;
}

function emptyRecord(): SystemTrackingRecord {
  return {
    toolsets: {},
    updatedAt: new Date().toISOString(),
  };
}

export async function readSystemTracking(home: string): Promise<SystemTrackingRecord> {
  try {
    const raw = await readFile(systemToolsetsFile(home), 'utf8');
    const parsed = JSON.parse(raw) as SystemTrackingRecord;
    if (!parsed || typeof parsed !== 'object' || !parsed.toolsets) return emptyRecord();
    return parsed;
  } catch {
    return emptyRecord();
  }
}

export async function writeSystemTracking(
  home: string,
  record: SystemTrackingRecord,
): Promise<void> {
  record.updatedAt = new Date().toISOString();
  const file = systemToolsetsFile(home);
  await mkdir(dirname(file), { recursive: true });
  await writeFileAtomic(file, `${JSON.stringify(record, null, 2)}\n`);
}
