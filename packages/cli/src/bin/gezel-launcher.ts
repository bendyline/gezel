import { unsupportedNodeMessage } from './node-version.js';

// This file must remain a tiny bootstrap. React chooses its reconciler at
// module-load time, so setting NODE_ENV inside the main command or TUI entry
// is too late once Ink has been imported.
if (!process.env.NODE_ENV) process.env.NODE_ENV = 'production';

// Keep the path indirect. A literal import() is folded into this entry by
// esbuild when code splitting is disabled, which would load Ink before the
// environment above can take effect.
const mainModule = './gezel-main.js';

// The version check has to run here, before the main module's static imports:
// on an older Node those crash inside undici before any CLI code runs. Set
// exitCode instead of calling exit() so the message flushes to a piped stderr.
const unsupported = unsupportedNodeMessage(process.versions.node);
if (unsupported) {
  process.stderr.write(unsupported);
  process.exitCode = 1;
} else {
  await import(mainModule);
}
