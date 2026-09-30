/**
 * Command-line handling for `gezeld`, run by the launcher before the daemon
 * loads. gezeld is configured through the environment; before this, every
 * argument was ignored and `gezeld --help` booted a full daemon against the
 * default home (2026-09-30 npm ship audit).
 *
 * Imported only by the launcher, so it must stay free of imports.
 */

/** The one argument a host passes: the Windows autostart task's pinned home (runtime-args.ts). */
const AUTOSTART_HOME_PREFIX = '--gezel-autostart-home=';

export type GezeldArgs =
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'run'; unrecognized: string[] };

export function parseGezeldArgs(argv: readonly string[]): GezeldArgs {
  if (argv.some((arg) => arg === '--help' || arg === '-h')) return { kind: 'help' };
  if (argv.some((arg) => arg === '--version' || arg === '-V' || arg === '-v')) {
    return { kind: 'version' };
  }
  // Unknown arguments are reported, not refused: a daemon that will not start
  // over an argument some host passes is worse than one that ignores it.
  return {
    kind: 'run',
    unrecognized: argv.filter((arg) => !arg.startsWith(AUTOSTART_HOME_PREFIX)),
  };
}

export const GEZELD_HELP = `Usage: gezeld [--help] [--version]

gezeld is the Gezel service. The Gezel app and the gezel command line
(\`gezel start\`) normally start it for you; run it directly to host the
service yourself. It stays in the foreground until stopped (Ctrl+C).

It is configured through the environment:
  GEZEL_HOME                     state directory (default ~/.gezel)
  GEZEL_PORT                     listen on this port (default 6228, or a free one)
  GEZEL_LOG_LEVEL                debug | info | warn | error | silent
  GEZEL_DAEMON_LOG_FILE=1        also write output to <home>/logs/service-YYYY-MM-DD.log
  GEZEL_SKIP_SYSTEM_BOOTSTRAP=1  skip first-boot background downloads
  GEZEL_MOCK_PROVIDER=1          deterministic provider, no credentials needed

More: https://github.com/bendyline/gezel/tree/main/packages/service
`;
