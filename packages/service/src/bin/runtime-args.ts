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
