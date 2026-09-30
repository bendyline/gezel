import { unsupportedNodeMessage } from './node-version.js';

// `dist/bin/gezeld.js`, the path every host resolves and spawns, is this tiny
// bootstrap in front of the daemon (./gezeld.ts, built as gezeld-main.js). The
// daemon entry's static imports load before its first line runs, and on an
// older Node they crash inside undici before any version check could. Set
// exitCode instead of calling exit() so the message flushes to a piped stderr.
const unsupported = unsupportedNodeMessage(process.versions.node);
if (unsupported) {
  process.stderr.write(unsupported);
  process.exitCode = 1;
} else {
  // Keep the path indirect: with code splitting disabled, esbuild folds a
  // literal import() into this entry and the daemon's imports load first again.
  const mainModule = './gezeld-main.js';
  await import(mainModule);
}
