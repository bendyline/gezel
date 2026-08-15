import { readFile } from 'node:fs/promises';

const [launcher, main, tui] = await Promise.all([
  readFile(new URL('../dist/bin/gezel.js', import.meta.url), 'utf8'),
  readFile(new URL('../dist/bin/gezel-main.js', import.meta.url), 'utf8'),
  readFile(new URL('../dist/tui/index.js', import.meta.url), 'utf8'),
]);

const failures = [];
if (
  !launcher.includes("process.env.NODE_ENV = 'production'") &&
  !launcher.includes('process.env.NODE_ENV = "production"')
) {
  failures.push('the launcher does not establish production mode');
}
if (!launcher.includes('gezel-main.js')) {
  failures.push('the launcher does not load the main command module');
}
if (/from\s+["'](?:ink|react|react-reconciler)/.test(launcher)) {
  failures.push('the launcher eagerly imports React/Ink');
}
if (/from\s+["'](?:ink|react|react-reconciler)/.test(main)) {
  failures.push('the main command eagerly imports React/Ink');
}
if (!/from\s+["']ink["']/.test(tui)) {
  failures.push('the TUI entry no longer owns the Ink import');
}

if (failures.length > 0) {
  throw new Error(`Invalid CLI lazy-load build:\n- ${failures.join('\n- ')}`);
}
