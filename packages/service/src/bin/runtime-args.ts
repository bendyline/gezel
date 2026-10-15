const AUTOSTART_HOME_PREFIX = '--gezel-autostart-home=';

/**
 * Task Scheduler has no per-action environment block. The Electron-generated
 * task passes its pinned home as an internal argument so gezeld can restore
 * GEZEL_HOME before resolving the managed Node and pnpm runtimes.
 */
export function applyAutostartRuntimeArguments(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): void {
  const homeArgs = argv.filter((arg) => arg.startsWith(AUTOSTART_HOME_PREFIX));
  if (homeArgs.length === 0) return;
  if (homeArgs.length !== 1) throw new Error('Duplicate --gezel-autostart-home arguments');

  const home = homeArgs[0]?.slice(AUTOSTART_HOME_PREFIX.length);
  if (!home || home.includes('\0')) throw new Error('Invalid --gezel-autostart-home argument');
  env.GEZEL_HOME = home;
}

/**
 * True when an OS autostart registration (LaunchAgent, systemd user unit,
 * logon task) started this daemon. Those managers relaunch a daemon that
 * exits unsuccessfully, so a refusal that is not a fault — another daemon
 * already owns the home — has to exit 0. Exiting 1 there had launchd
 * relaunching the refused daemon every ten seconds for as long as the owner
 * lived, each attempt loading the whole service bundle to be refused again.
 */
export function isAutostartLaunch(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.GEZEL_AUTOSTART === '1' || argv.some((arg) => arg.startsWith(AUTOSTART_HOME_PREFIX));
}
