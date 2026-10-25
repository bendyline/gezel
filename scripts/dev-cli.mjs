#!/usr/bin/env node
/**
 * Run the workspace's built CLI against the dev home (`GEZEL_DEV=1`, so
 * `~/.gezel-dev`), passing every argument through.
 *
 * A script rather than a `GEZEL_DEV=1 node …` prefix, which only POSIX shells
 * understand: pnpm runs scripts through cmd.exe on Windows.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const result = spawnSync(
  process.execPath,
  [join(repoRoot, 'packages', 'cli', 'dist', 'bin', 'gezel.js'), ...process.argv.slice(2)],
  { stdio: 'inherit', env: { ...process.env, GEZEL_DEV: '1' } },
);
process.exit(result.status ?? 1);
