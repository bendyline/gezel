/**
 * Structural "has anyone ever used this home?" signals, read straight off
 * the filesystem before any daemon is running.
 *
 * Used by the supervisor to keep a machine-service adoption from stranding
 * real per-user data: when the system-scope home is factory-fresh while
 * `~/.gezel` holds the user's actual gezels and projects, connecting to the
 * machine service presents an empty app with no hint that everything the
 * user made still exists one directory over.
 *
 * `config.firstRunCompleted` is deliberately NOT the signal. The first-run
 * bootstrap sets it on every daemon boot — including a headless machine
 * service that no human has ever seen — so it means "a daemon ran here",
 * not "a person used this". Gezel count is not the signal either: boot
 * auto-creates the whole system crew (Meester, Klerk, Boekwachter), so a
 * fresh home already holds several. The honest evidence is a persisted
 * chat session or a project beyond the auto-created `default` — both only
 * ever come from use.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface HomeUsageSignals {
  gezelCount: number;
  projectCount: number;
  hasAnySession: boolean;
  /** True when the structure can only come from actual use. */
  everUsed: boolean;
}

export async function readHomeUsageSignals(home: string): Promise<HomeUsageSignals> {
  const gezelIds = await listDirs(join(home, 'gezels'));
  const projectIds = await listDirs(join(home, 'projects'));
  let hasAnySession = false;
  for (const id of gezelIds) {
    const sessions = await listFiles(join(home, 'gezels', id, 'sessions'));
    if (sessions.some((f) => f.endsWith('.json'))) {
      hasAnySession = true;
      break;
    }
  }
  return {
    gezelCount: gezelIds.length,
    projectCount: projectIds.length,
    hasAnySession,
    // Boot auto-creates the system crew and the `default` project, so
    // gezel count says nothing. Sessions and extra projects do.
    everUsed: hasAnySession || projectIds.length > 1,
  };
}

export type HostingPin = 'auto' | 'machine-service' | 'per-user';

/**
 * The user's persisted hosting choice from `<home>/config.json`. Same
 * pre-Store bare-JSON pattern as the supervisor's other config peeks
 * (`readRemoteConfig`, `readBackendOverride`): the service isn't running
 * yet, so the HTTP API can't answer. Missing/malformed → `'auto'`.
 */
export async function readHostingPin(home: string): Promise<HostingPin> {
  try {
    const raw = await readFile(join(home, 'config.json'), 'utf8');
    const parsed = JSON.parse(raw) as { hosting?: unknown };
    if (parsed.hosting === 'machine-service' || parsed.hosting === 'per-user') {
      return parsed.hosting;
    }
  } catch {
    /* fall through to auto */
  }
  return 'auto';
}

/**
 * Persist an auto-decided hosting pin into `<home>/config.json`, preserving
 * every other field. Read-modify-write rather than Store on purpose — this
 * runs in Electron main before (or instead of) any daemon for this home.
 * The `hosting` key is part of the core config schema, so a later Store
 * rewrite round-trips it. Best-effort: a failed write only costs the next
 * launch a repeat of the same cheap decision.
 */
export async function writeHostingPin(home: string, pin: HostingPin): Promise<boolean> {
  try {
    const path = join(home, 'config.json');
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    } catch {
      /* absent or malformed — write a minimal object */
    }
    parsed.hosting = pin;
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

async function listDirs(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

async function listFiles(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((e) => e.isFile()).map((e) => e.name);
  } catch {
    return [];
  }
}
