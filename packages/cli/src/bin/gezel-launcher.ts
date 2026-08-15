// This file must remain a tiny bootstrap. React chooses its reconciler at
// module-load time, so setting NODE_ENV inside the main command or TUI entry
// is too late once Ink has been imported.
if (!process.env.NODE_ENV) process.env.NODE_ENV = 'production';

// Keep the path indirect. A literal import() is folded into this entry by
// esbuild when code splitting is disabled, which would load Ink before the
// environment above can take effect.
const mainModule = './gezel-main.js';
await import(mainModule);

export {};
