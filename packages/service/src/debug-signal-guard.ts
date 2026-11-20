import { createLogger } from '@bendyline/gezel';
import { DISABLE_DEBUG_SIGNAL_FLAG } from '@bendyline/gezel/native';

const log = createLogger('service');

export type DebugSignalGuard = 'flag' | 'listener' | 'inspector' | 'electron' | 'unguarded';

interface GuardedProcess {
  platform: NodeJS.Platform;
  execArgv: readonly string[];
  env: NodeJS.ProcessEnv;
  type?: string;
  on(event: 'SIGUSR1', listener: () => void): unknown;
}

let guarded: DebugSignalGuard | undefined;

/**
 * Keep other processes of this account out of the daemon's inspector (see
 * core native/debug-signal.ts). Every launcher Gezel owns passes
 * `--disable-sigusr1`; this covers the hosts that may not: an app embedding
 * the service, a utility process whose fuse ignores NODE_OPTIONS, a
 * hand-written unit. On POSIX a SIGUSR1 listener takes the signal from the
 * inspector (verified on Node 24 under Linux); Windows' `_debugProcess` has
 * no such remedy, so there it can only be named.
 */
export function guardDebugSignal(proc: GuardedProcess = process): DebugSignalGuard {
  const args = [...proc.execArgv, ...(proc.env.NODE_OPTIONS?.split(/\s+/) ?? [])];
  if (args.includes(DISABLE_DEBUG_SIGNAL_FLAG)) return 'flag';
  // Someone debugging the daemon on purpose already has an inspector open.
  if (args.some((arg) => /^--inspect(?:-brk|-wait)?(?:=|$)/.test(arg))) return 'inspector';
  if (proc.platform !== 'win32') {
    proc.on('SIGUSR1', () => {
      log.warn('ignored SIGUSR1: this daemon does not open an inspector on request');
    });
    return 'listener';
  }
  // Electron's main process keeps the inspector shut through the app's fuse;
  // the supervisor forks its utility process with the flag in NODE_OPTIONS,
  // which the entry clears again before the service starts.
  if (proc.type === 'browser' || proc.type === 'utility') return 'electron';
  log.warn(
    `started without ${DISABLE_DEBUG_SIGNAL_FLAG}: another process of this account could open this daemon's inspector; start gezeld with that flag`,
  );
  return 'unguarded';
}

/** Once per process: an embedded host restarts the service in place. */
export function guardDebugSignalOnce(): DebugSignalGuard {
  guarded ??= guardDebugSignal();
  return guarded;
}
