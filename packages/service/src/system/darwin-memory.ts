import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export interface DarwinSystemMemorySnapshot {
  /** RAM occupied by app, wired, and compressed memory. */
  usedBytes: number;
  /** Reclaimable file-backed and purgeable pages (Activity Monitor "Cached Files"). */
  cachedBytes: number;
  /** Completely unused physical pages. */
  freeBytes: number;
}

export type DarwinMemoryCommandRunner = (command: string, args: string[]) => Promise<string>;

interface CachedDarwinMemory {
  at: number;
  value: DarwinSystemMemorySnapshot | null;
}

let cached: CachedDarwinMemory | null = null;
let pending: Promise<DarwinSystemMemorySnapshot | null> | null = null;

function pageCount(stdout: string, label: string): number | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = stdout.match(new RegExp(`^${escaped}:\\s*(\\d+)\\.?\\s*$`, 'im'));
  if (!match) return null;
  const count = Number.parseInt(match[1]!, 10);
  return Number.isFinite(count) && count >= 0 ? count : null;
}

/**
 * Convert `vm_stat`'s Mach page counters into the same top-level buckets
 * Activity Monitor presents. File-backed and purgeable pages are cached,
 * reclaimable capacity; treating only `Pages free` as available makes a
 * healthy Mac appear completely full.
 */
export function parseDarwinVmStat(
  stdout: string,
  totalBytes: number,
): DarwinSystemMemorySnapshot | null {
  const pageSizeMatch = stdout.match(/page size of\s+(\d+)\s+bytes/i);
  if (!pageSizeMatch || !Number.isFinite(totalBytes) || totalBytes <= 0) return null;

  const pageSize = Number.parseInt(pageSizeMatch[1]!, 10);
  const freePages = pageCount(stdout, 'Pages free');
  const fileBackedPages = pageCount(stdout, 'File-backed pages');
  const purgeablePages = pageCount(stdout, 'Pages purgeable');
  if (
    !Number.isFinite(pageSize) ||
    pageSize <= 0 ||
    freePages === null ||
    fileBackedPages === null ||
    purgeablePages === null
  ) {
    return null;
  }

  const freeBytes = clamp(freePages * pageSize, 0, totalBytes);
  const cachedBytes = clamp(
    (fileBackedPages + purgeablePages) * pageSize,
    0,
    totalBytes - freeBytes,
  );
  const usedBytes = Math.max(0, totalBytes - freeBytes - cachedBytes);
  return { usedBytes, cachedBytes, freeBytes };
}

export async function sampleDarwinSystemMemory(opts: {
  totalBytes: number;
  platform?: NodeJS.Platform;
  run?: DarwinMemoryCommandRunner;
}): Promise<DarwinSystemMemorySnapshot | null> {
  if ((opts.platform ?? process.platform) !== 'darwin') return null;
  const run = opts.run ?? runCommand;
  try {
    return parseDarwinVmStat(await run('/usr/bin/vm_stat', []), opts.totalBytes);
  } catch {
    return null;
  }
}

/** Coalesce the engine popover's one-second polling into a cheap live sample. */
export async function sampleDarwinSystemMemoryCached(opts: {
  totalBytes: number;
  maxAgeMs?: number;
}): Promise<DarwinSystemMemorySnapshot | null> {
  if (process.platform !== 'darwin') return null;
  const now = Date.now();
  const maxAgeMs = opts.maxAgeMs ?? 3_000;
  if (cached && now - cached.at <= maxAgeMs) return cached.value;
  if (pending) return pending;

  pending = sampleDarwinSystemMemory({ totalBytes: opts.totalBytes })
    .then((value) => {
      cached = { at: Date.now(), value };
      return value;
    })
    .finally(() => {
      pending = null;
    });
  return pending;
}

async function runCommand(command: string, args: string[]): Promise<string> {
  const { stdout } = await exec(command, args, {
    encoding: 'utf8',
    timeout: 3_000,
    maxBuffer: 1024 * 1024,
  });
  return String(stdout);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
