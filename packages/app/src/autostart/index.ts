import * as darwin from './darwin.js';
import * as linux from './linux.js';
import * as win32 from './win32.js';

export interface AutostartModule {
  /** Write the unit file and register with the OS. Idempotent. */
  install(opts: AutostartInstallOptions): Promise<void>;
  /** Deregister and remove the unit file. Idempotent. */
  uninstall(): Promise<void>;
  /** True if the OS is currently configured to launch gezeld at login. */
  isInstalled(): Promise<boolean>;
}

export interface AutostartInstallOptions {
  /** Absolute path to `gezeld.js` (or a wrapper binary) in the user's install dir. */
  gezeldPath: string;
  /** Absolute path to the supervisor-installed, manifest-verified Node binary. */
  nodePath: string;
  /** Bundled ordinary pnpm package entrypoint; required by packaged Electron. */
  pnpmPath?: string;
  /** `GEZEL_HOME` to pass to the child as an env var. */
  gezelHome: string;
}

/**
 * The service-manager side of autostart, on the platforms whose unit relaunches
 * a daemon that exits unsuccessfully (launchd, systemd). There the unit — not
 * the app — owns the daemon's lifetime, so stopping or restarting it by pid
 * only starts a race with the manager's relaunch; every lifecycle change goes
 * through the manager instead. Windows' logon task relaunches nothing, so the
 * supervisor's ordinary stop-and-respawn already works there.
 */
export interface ManagedAutostart {
  /**
   * The `GEZEL_HOME` the registered unit serves, or null when none is
   * registered. There is one unit per OS account, so a unit serving another
   * home (a `--gezel-home` sandbox, a test) is not this launch's to manage.
   */
  registeredHome(): Promise<string | null>;
  /** True when the registered unit is exactly what {@link install} would write for `opts`. */
  isCurrent(opts: AutostartInstallOptions): Promise<boolean>;
  /** Write the unit for `opts` and (re)start its daemon from it. */
  install(opts: AutostartInstallOptions): Promise<void>;
  /** Stop the daemon if it runs, then start it from the registered unit. */
  restart(): Promise<void>;
  /** Stop the daemon until the next login; the registration itself stays. */
  stop(): Promise<void>;
}

export function managedAutostart(
  platform: NodeJS.Platform = process.platform,
): ManagedAutostart | null {
  if (platform === 'darwin') return darwin;
  if (platform === 'linux') return linux;
  return null;
}

function impl(): AutostartModule {
  if (process.platform === 'darwin') return darwin;
  if (process.platform === 'linux') return linux;
  if (process.platform === 'win32') return win32;
  throw new Error(`Autostart is not supported on ${process.platform}`);
}

export const autostart: AutostartModule = {
  install: (opts) => impl().install(opts),
  uninstall: () => impl().uninstall(),
  isInstalled: () => impl().isInstalled(),
};
