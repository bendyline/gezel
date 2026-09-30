import { GEZELD_HELP, parseGezeldArgs } from './gezeld-args.js';
import { unsupportedNodeMessage } from './node-version.js';

// `dist/bin/gezeld.js`, the path every host resolves and spawns, is this tiny
// bootstrap in front of the daemon (./gezeld.ts, built as gezeld-main.js). The
// daemon entry's static imports load before its first line runs, and on an
// older Node they crash inside undici before any version check could. Set
// exitCode instead of calling exit() so the message flushes to a piped stderr.
const unsupported = unsupportedNodeMessage(process.versions.node);
const args = parseGezeldArgs(process.argv.slice(2));
if (unsupported) {
  process.stderr.write(unsupported);
  process.exitCode = 1;
} else if (args.kind === 'help') {
  process.stdout.write(GEZELD_HELP);
} else if (args.kind === 'version') {
  // External to this bundle, so a literal import() stays a runtime import.
  const { GEZEL_VERSION } = await import('@bendyline/gezel');
  process.stdout.write(`${GEZEL_VERSION}\n`);
} else {
  for (const arg of args.unrecognized) {
    process.stderr.write(`gezeld: ignoring unrecognized argument ${arg} (see gezeld --help)\n`);
  }
  // Keep the path indirect: with code splitting disabled, esbuild folds a
  // literal import() into this entry and the daemon's imports load first again.
  const mainModule = './gezeld-main.js';
  await import(mainModule);
}
