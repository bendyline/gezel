/**
 * What `gezel stop` may do to the daemon named in `runtime/pid`.
 *
 * It used to kill that pid unchecked. Against the desktop app's own daemon
 * that killed a process the supervisor restarts; against an in-process
 * embedded service the pid is Electron's, so it closed the app; and after a
 * crash, a reused pid force-killed an unrelated process tree (taskkill /T /F
 * on Windows). A kill now needs the process to be confirmed as a standalone
 * gezeld, by the daemon's own health answer or by its command line.
 */
export type DaemonStopPlan =
  /** No runtime files. */
  | { kind: 'not-running' }
  /** The recorded process is gone; only its runtime files are left. */
  | { kind: 'stale' }
  /** The desktop app owns the daemon: brake it, never kill it. */
  | { kind: 'brake' }
  /** Confirmed standalone gezeld. */
  | { kind: 'kill' }
  /** Nothing answers and the pid now belongs to another program. */
  | { kind: 'foreign'; command: string }
  /** The service on the recorded port reports a different pid. */
  | { kind: 'mismatch'; healthPid: number }
  /** Nothing answers and the process list could not be read. */
  | { kind: 'unconfirmed' };

/** The `/api/health` fields the decision reads; older daemons send neither. */
export interface DaemonStopHealth {
  pid?: number;
  hostedBy?: 'app' | 'standalone';
}

export async function planDaemonStop(input: {
  pid: number | null;
  alive: (pid: number) => boolean;
  /** Null when nothing answered on the recorded port. */
  health: DaemonStopHealth | null;
  /** The process's command line; null when it cannot be read. */
  commandOf: (pid: number) => Promise<string | null>;
}): Promise<DaemonStopPlan> {
  const { pid, health } = input;
  if (pid === null) return { kind: 'not-running' };
  if (!input.alive(pid)) return { kind: 'stale' };
  if (health?.hostedBy === 'app') return { kind: 'brake' };
  if (health?.pid !== undefined) {
    if (health.pid !== pid) return { kind: 'mismatch', healthPid: health.pid };
    if (health.hostedBy === 'standalone') return { kind: 'kill' };
  }
  const command = await input.commandOf(pid);
  if (command !== null && isGezeldCommand(command)) return { kind: 'kill' };
  // A daemon too old to report its host answered, but the pid is not gezeld:
  // the service runs inside another process, which in practice is the app.
  if (health) return { kind: 'brake' };
  if (command === null) return { kind: 'unconfirmed' };
  return { kind: 'foreign', command };
}

/** True when the command line runs the gezeld entry point (gezeld, gezeld.js). */
export function isGezeldCommand(command: string): boolean {
  return /(?:^|[\\/\s"'])gezeld(?:\.[cm]?js|\.exe)?(?=["'\s]|$)/i.test(command);
}
