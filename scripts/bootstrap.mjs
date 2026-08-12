#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { workspaceDependenciesReady } from './pnpm-install.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '..');

if (workspaceDependenciesReady(repoRoot)) process.exit(0);

const probe = spawnSync('pnpm', ['--version'], {
  stdio: 'ignore',
  shell: process.platform === 'win32',
});
if (probe.status !== 0) {
  console.error('[bootstrap] pnpm was not found on your PATH.');
  console.error('');
  console.error('Node ≥22 ships with Corepack, which can provision the exact pnpm version');
  console.error('this repo pins in package.json. Run these once, then retry:');
  console.error('');
  console.error('  corepack enable');
  console.error('  corepack prepare pnpm@11.15.1 --activate');
  console.error('');
  console.error('See the README "Getting started" section for details.');
  process.exit(1);
}

console.log('[bootstrap] dependencies missing or incomplete — waiting for the shared install lock');
const result = spawnSync(process.execPath, [join(scriptsDir, 'pnpm-install.mjs'), '--if-missing'], {
  stdio: 'inherit',
  cwd: repoRoot,
});
process.exit(result.status ?? 1);
