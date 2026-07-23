/**
 * Keep long local-engine evals awake on macOS.
 *
 * An MLX process can continue to hold the device while the machine enters an
 * idle/dark-wake cycle. Besides stretching wall-clock time, that can make the
 * harness misclassify a healthy model as stuck. `caffeinate -w` scopes the
 * assertion to the eval owner PID, so a crash cannot leave a durable setting
 * behind.
 */
import { type ChildProcess, spawn } from 'node:child_process';

export const EVAL_ALLOW_SLEEP_ENV = 'GEZEL_EVAL_ALLOW_SLEEP';

export interface EvalSleepGuardLease {
  release(): void;
}

export interface AcquireEvalSleepGuardOptions {
  pid?: number;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  spawnProcess?: typeof spawn;
  warn?: (message: string) => void;
}

/**
 * Acquire a process-scoped macOS idle-sleep assertion. Other platforms and
 * the explicit opt-out are no-ops. Failure to launch caffeinate is advisory:
 * the eval still runs, but emits a warning so its timing can be interpreted
 * cautiously.
 */
export function acquireEvalSleepGuard(
  options: AcquireEvalSleepGuardOptions = {},
): EvalSleepGuardLease | null {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  if (platform !== 'darwin' || env[EVAL_ALLOW_SLEEP_ENV] === '1') return null;

  const pid = options.pid ?? process.pid;
  const spawnProcess = options.spawnProcess ?? spawn;
  const warn = options.warn ?? ((message: string) => console.warn(message));
  let child: ChildProcess;
  try {
    // -i prevents idle system sleep; -m prevents idle disk sleep. Avoid -d so
    // the display can still turn off during a multi-hour unattended matrix.
    child = spawnProcess('caffeinate', ['-im', '-w', String(pid)], {
      stdio: 'ignore',
    });
  } catch (error) {
    warn(`[evals] could not start macOS sleep guard: ${String(error)}`);
    return null;
  }

  child.once('error', (error) => {
    warn(`[evals] macOS sleep guard unavailable: ${error.message}`);
  });
  child.unref();

  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
    },
  };
}
