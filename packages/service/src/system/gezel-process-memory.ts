import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isGezelEngineCommand } from '@bendyline/gezel-client/node';

const exec = promisify(execFile);

export interface ProcessListEntry {
  pid: number;
  ppid: number;
  command: string;
}

export interface GezelProcessMemorySnapshot {
  /** Combined macOS physical footprint for gezeld plus same-home engines. */
  bytes: number;
  engineProcessCount: number;
  orphanedEngineProcessCount: number;
}

export type ProcessMemoryCommandRunner = (command: string, args: string[]) => Promise<string>;

interface CachedProcessMemory {
  at: number;
  value: GezelProcessMemorySnapshot | null;
}

const cachedByHome = new Map<string, CachedProcessMemory>();
const pendingByHome = new Map<string, Promise<GezelProcessMemorySnapshot | null>>();

/** Parse `ps -axo pid=,ppid=,command=` without truncating the command tail. */
export function parseProcessList(stdout: string): ProcessListEntry[] {
  const entries: ProcessListEntry[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const match = rawLine.trimStart().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    const pid = Number.parseInt(match[1]!, 10);
    const ppid = Number.parseInt(match[2]!, 10);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    entries.push({ pid, ppid, command: match[3]! });
  }
  return entries;
}

/**
 * Identify engine processes launched for this Gezel home. The executable or
 * script marker proves it is one of our engines; the home path prevents a dev
 * daemon from claiming an isolated eval or another local installation.
 */
export function findGezelEngineProcesses(
  entries: ProcessListEntry[],
  home: string,
  platform: NodeJS.Platform = process.platform,
): ProcessListEntry[] {
  const separator = platform === 'win32' ? '\\' : '/';
  const normalizedHome = normalizeProcessCommand(home, platform).replace(/[\\/]+$/, '');
  const homeAnchor = `${normalizedHome}${separator}`;
  return entries.filter(({ command }) => {
    const normalizedCommand = normalizeProcessCommand(command, platform);
    return normalizedCommand.includes(homeAnchor) && isGezelEngineCommand(command);
  });
}

function normalizeProcessCommand(value: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? value.replaceAll('/', '\\').toLowerCase() : value;
}

/** Parse the byte-form summary emitted by `/usr/bin/footprint`. */
export function parseFootprintBytes(stdout: string): number | null {
  const summary = stdout.match(/Summary Footprint:\s*(\d+)\s+B/i);
  if (summary) {
    const bytes = Number.parseInt(summary[1]!, 10);
    return Number.isFinite(bytes) && bytes >= 0 ? bytes : null;
  }

  // A target can disappear between ps and footprint. Some macOS releases
  // still emit the surviving targets without a final summary, so retain the
  // useful measurements instead of dropping the whole sample.
  let total = 0;
  let found = false;
  for (const match of stdout.matchAll(/^\s*phys_footprint:\s*(\d+)\s+B/gim)) {
    const bytes = Number.parseInt(match[1]!, 10);
    if (!Number.isFinite(bytes) || bytes < 0) continue;
    total += bytes;
    found = true;
  }
  return found ? total : null;
}

/**
 * Observe the same physical-footprint metric Activity Monitor uses on macOS.
 * Unlike RSS, this includes Metal-backed unified-memory allocations (the
 * difference is tens of GiB for MLX and DS4).
 */
export async function sampleDarwinGezelProcessMemory(opts: {
  home: string;
  platform?: NodeJS.Platform;
  servicePid?: number;
  run?: ProcessMemoryCommandRunner;
}): Promise<GezelProcessMemorySnapshot | null> {
  if ((opts.platform ?? process.platform) !== 'darwin') return null;
  const run = opts.run ?? runCommand;
  const servicePid = opts.servicePid ?? process.pid;

  try {
    const processList = parseProcessList(await run('/bin/ps', ['-axo', 'pid=,ppid=,command=']));
    const engines = findGezelEngineProcesses(processList, opts.home);
    const pids = [...new Set([servicePid, ...engines.map(({ pid }) => pid)])];
    const args = [
      '--noCategories',
      '--format',
      'bytes',
      ...pids.flatMap((pid) => ['--pid', String(pid)]),
    ];
    const bytes = parseFootprintBytes(await run('/usr/bin/footprint', args));
    if (bytes === null) return null;
    return {
      bytes,
      engineProcessCount: engines.length,
      orphanedEngineProcessCount: engines.filter(({ ppid }) => ppid === 1).length,
    };
  } catch {
    // Sandboxed/dev hosts may deny process inspection. The caller retains the
    // portable reservation-based estimate as a fallback.
    return null;
  }
}

/**
 * The UI polls once a second; process discovery + footprint are cheap but not
 * free. Coalesce concurrent requests and refresh at a human-live cadence.
 */
export async function sampleDarwinGezelProcessMemoryCached(opts: {
  home: string;
  maxAgeMs?: number;
}): Promise<GezelProcessMemorySnapshot | null> {
  if (process.platform !== 'darwin') return null;
  const key = `${opts.home}\0${process.pid}`;
  const now = Date.now();
  const maxAgeMs = opts.maxAgeMs ?? 3_000;
  const cached = cachedByHome.get(key);
  if (cached && now - cached.at <= maxAgeMs) return cached.value;
  const pending = pendingByHome.get(key);
  if (pending) return pending;

  const sample = sampleDarwinGezelProcessMemory({ home: opts.home })
    .then((value) => {
      cachedByHome.set(key, { at: Date.now(), value });
      return value;
    })
    .finally(() => {
      pendingByHome.delete(key);
    });
  pendingByHome.set(key, sample);
  return sample;
}

async function runCommand(command: string, args: string[]): Promise<string> {
  const { stdout } = await exec(command, args, {
    encoding: 'utf8',
    timeout: 3_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return String(stdout);
}
