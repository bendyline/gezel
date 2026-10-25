#!/usr/bin/env node
/**
 * Remove build output, relative to the working directory:
 *
 *   node ../../scripts/clean-dirs.mjs dist .turbo
 *
 * Package `clean` scripts use this rather than `rm -rf`: pnpm runs scripts
 * through cmd.exe on Windows, which has no `rm`, so every clean (and the root
 * `clean`, `rebuild` and `app:clean` built on them) failed there. A path
 * outside the working directory is refused, so a stray `..` cannot reach
 * past the package.
 */
import { rmSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error('usage: clean-dirs.mjs <path>...');
  process.exit(2);
}
const cwd = process.cwd();
for (const target of targets) {
  const path = resolve(cwd, target);
  const fromCwd = relative(cwd, path);
  if (!fromCwd || fromCwd.startsWith('..') || resolve(fromCwd) !== path) {
    console.error(`clean-dirs: refusing ${target}, which is not inside ${cwd}`);
    process.exit(2);
  }
  rmSync(path, { recursive: true, force: true });
}
