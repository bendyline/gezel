import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { AutostartInstallOptions, ManagedAutostart } from '../autostart/index.js';

/**
 * Bring a registered autostart daemon onto the service this app ships, then
 * hand the connection to it.
 *
 * An autostart unit used to pin `~/.gezel/service`, which nothing refreshes
 * once the installer's shared service tree is adopted, so it ran the release
 * that last extracted it forever. And when the app found that daemon at the
 * wrong version it SIGTERMed it, launchd's KeepAlive relaunched it at once,
 * and the two raced for the home lock: the stale daemon won on most launches
 * and the app spoke to a months-old service. So the unit is rewritten to the
 * current definition first, and every stop and restart goes through the
 * service manager, never a signal the manager answers with a relaunch.
 */

export interface AutostartRuntime {
  pid: number;
  baseUrl: string;
  token: string;
  cert: string | null;
}

export type AutostartHandover =
  | { kind: 'not-registered' }
  | { kind: 'adopted'; runtime: AutostartRuntime; version: string; repaired: boolean }
  /**
   * The unit could not be brought onto the shipped service. It has been
   * stopped for this login session, so the caller can serve the app itself
   * without the manager relaunching a competitor.
   */
  | { kind: 'declined'; reason: string };

export interface AutostartHandoverOptions {
  home: string;
  autostart: ManagedAutostart;
  /** What the unit must point at: the service tree this launch uses and its verified runtimes. */
  definition: () => Promise<AutostartInstallOptions>;
  /** `null` when the app cannot read its own bundle version; any healthy daemon is then accepted. */
  shippedVersion: string | null;
  readRuntime: (home: string) => Promise<AutostartRuntime | null>;
  isProcessAlive: (pid: number) => boolean;
  /** The daemon's `/api/health` version; rejects while it is still booting. */
  healthVersion: (runtime: AutostartRuntime) => Promise<string>;
  /** Stop a daemon the unit does not own, such as one `gezel start` launched. */
  stopPid: (pid: number) => Promise<boolean>;
  timeoutMs?: number;
  pollMs?: number;
  logger?: { info?: (m: string) => void; warn?: (m: string) => void };
}

const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_POLL_MS = 500;
/**
 * Restarts the handover may initiate. The first moves a stale or stopped
 * daemon onto the current unit; the second covers a competitor that held the
 * home while the first came up. A third would repeat a failure.
 */
const MAX_RESTARTS = 2;

export async function handOverToAutostart(
  opts: AutostartHandoverOptions,
): Promise<AutostartHandover> {
  const { autostart, logger } = opts;
  if (!(await autostartServesHome(autostart, opts.home, logger))) return { kind: 'not-registered' };

  const decline = async (reason: string): Promise<AutostartHandover> => {
    logger?.warn?.(
      `[supervisor] autostart handover declined: ${reason}; stopping it for this session`,
    );
    try {
      await autostart.stop();
    } catch (error) {
      logger?.warn?.(`[supervisor] could not stop the autostart daemon: ${message(error)}`);
    }
    return { kind: 'declined', reason };
  };

  let definition: AutostartInstallOptions;
  try {
    definition = await opts.definition();
  } catch (error) {
    return decline(`the current service could not be described: ${message(error)}`);
  }

  let repaired = false;
  // Counts every start this call caused, including the re-registration, so a
  // daemon still booting from it is waited for rather than restarted again.
  let restarts = 0;
  if (!(await autostart.isCurrent(definition))) {
    logger?.warn?.(
      `[supervisor] autostart pointed at an outdated service; re-registering it for ${definition.gezeldPath}`,
    );
    try {
      await autostart.install(definition);
    } catch (error) {
      return decline(`re-registering autostart failed: ${message(error)}`);
    }
    repaired = true;
    restarts += 1;
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const deadline = Date.now() + timeoutMs;
  let lastSeen = 'no daemon published a runtime';

  for (;;) {
    const runtime = await opts.readRuntime(opts.home);
    const live = runtime !== null && opts.isProcessAlive(runtime.pid);
    let version: string | null = null;
    if (live) {
      try {
        version = await opts.healthVersion(runtime);
      } catch (error) {
        lastSeen = `pid ${runtime.pid} is not answering yet (${message(error)})`;
      }
    }

    if (live && version !== null) {
      if (opts.shippedVersion === null || version === opts.shippedVersion) {
        logger?.info?.(
          `[supervisor] adopting the autostart daemon pid=${runtime.pid} v${version}${repaired ? ' (unit repaired)' : ''}`,
        );
        return { kind: 'adopted', runtime, version, repaired };
      }
      lastSeen = `pid ${runtime.pid} serves v${version}, this app ships v${opts.shippedVersion}`;
      if (restarts >= MAX_RESTARTS) return decline(lastSeen);
      logger?.warn?.(`[supervisor] ${lastSeen}; restarting it through the service manager`);
      try {
        await autostart.stop();
        // Still alive after the manager stopped its own daemon: this one was
        // started by something else, and would keep the restarted unit out.
        if (opts.isProcessAlive(runtime.pid) && !(await opts.stopPid(runtime.pid))) {
          return decline(`pid ${runtime.pid} (v${version}) did not exit when asked`);
        }
        await autostart.restart();
      } catch (error) {
        return decline(`restarting autostart failed: ${message(error)}`);
      }
      restarts += 1;
    } else if (!live && restarts === 0) {
      // Registered but not running: stood down beside an earlier owner,
      // stopped by a previous decline, or between crash relaunches.
      logger?.info?.('[supervisor] autostart is registered but not running; starting it');
      try {
        await autostart.restart();
      } catch (error) {
        return decline(`starting autostart failed: ${message(error)}`);
      }
      restarts += 1;
    }

    if (Date.now() >= deadline) {
      return decline(`no daemon at the shipped version within ${timeoutMs}ms (${lastSeen})`);
    }
    await delay(pollMs);
  }
}

/**
 * True when the account's autostart unit is registered for `home`. There is
 * one unit per OS account; a unit serving another home belongs to whichever
 * launch registered it, and rewriting it from here would move that user's
 * autostart onto this home.
 */
export async function autostartServesHome(
  autostart: ManagedAutostart,
  home: string,
  logger?: { info?: (m: string) => void },
): Promise<boolean> {
  const registered = await autostart.registeredHome();
  if (registered === null) return false;
  if (resolve(registered) === resolve(home)) return true;
  logger?.info?.(`[supervisor] autostart serves ${registered}, not ${home}; leaving it alone`);
  return false;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
