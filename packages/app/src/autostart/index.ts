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
