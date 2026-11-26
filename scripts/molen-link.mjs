#!/usr/bin/env node
// Adapted from squisq-link.mjs for @bendyline/molen-stage, which the service
// uses to check the films, games and scenes a gezel writes. It is an optional
// dependency of the service: until a release is on npm, this link is the only
// way to install it, and without it the service runs with no Molen checks.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runLockfileRefreshAndInstall, withPnpmInstallLock } from './pnpm-install.mjs';

const mode = process.argv[2];
if (mode !== 'link' && mode !== 'unlink') {
  console.error('Usage: molen-link.mjs <link|unlink>');
  process.exit(1);
}

const OVERRIDES = {
  '@bendyline/molen-stage': 'link:../molen/packages/stage',
};

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '..');
const workspacePath = join(repoRoot, 'pnpm-workspace.yaml');
const molenRoot = resolve(repoRoot, '..', 'molen');

if (mode === 'link') {
  for (const [name, spec] of Object.entries(OVERRIDES)) {
    const target = resolve(repoRoot, spec.replace(/^link:/, ''));
    const pkgPath = join(target, 'package.json');
    if (!existsSync(pkgPath)) {
      console.error(`[molen] missing ${name} at ${target} - clone the molen checkout beside gezel`);
      process.exit(1);
    }
    if (JSON.parse(readFileSync(pkgPath, 'utf8')).name !== name) {
      console.error(`[molen] ${target} is not the ${name} package`);
      process.exit(1);
    }
  }

  // A link: dependency exposes the package directory immediately, so build it
  // (and the Molen packages it depends on) before changing pnpm's resolution:
  // the service must never start against a missing or stale dist tree.
  console.log('[molen] building molen-stage and its dependencies before linking');
  const build = spawnSync('pnpm', ['--filter', '@bendyline/molen-stage...', 'build'], {
    stdio: 'inherit',
    cwd: molenRoot,
    shell: process.platform === 'win32',
  });
  if (build.status !== 0) {
    console.error('[molen] build failed - local resolution was not changed');
    process.exit(build.status ?? 1);
  }
}

const installStatus = await withPnpmInstallLock(
  repoRoot,
  async ({ setChildPid }) => {
    const workspaceRaw = await readFile(workspacePath, 'utf8');
    const nextWorkspace = updateWorkspaceOverrides(workspaceRaw, mode);
    const workspaceChanged = nextWorkspace !== workspaceRaw;
    if (workspaceChanged) await writeFile(workspacePath, nextWorkspace);

    if (!workspaceChanged) {
      console.log(
        mode === 'link'
          ? '[molen] local resolution already active - reconciling the lockfile and install'
          : '[molen] already unlinked - reconciling the lockfile and install',
      );
    } else if (mode === 'link') {
      console.log('[molen] linked the local molen-stage via pnpm-workspace.yaml overrides');
    } else {
      console.log('[molen] removed the molen-stage override - installing from the registry');
      console.log(
        '[molen] until that version is published it is skipped, and Molen documents go unchecked',
      );
    }

    return runLockfileRefreshAndInstall({ repoRoot, setChildPid });
  },
  { command: `pnpm ${mode}:molen` },
);
process.exitCode = installStatus;

function updateWorkspaceOverrides(source, operation) {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const hadFinalNewline = source.endsWith('\n');
  const lines = source.split(/\r?\n/);
  if (hadFinalNewline) lines.pop();

  let overridesStart = lines.findIndex((line) => /^overrides:\s*$/.test(line));
  if (overridesStart === -1) {
    if (operation === 'unlink') return source;
    const firstTopLevelAfterPackages = lines.findIndex(
      (line, index) => index > 0 && /^\S/.test(line),
    );
    overridesStart = firstTopLevelAfterPackages === -1 ? lines.length : firstTopLevelAfterPackages;
    lines.splice(overridesStart, 0, 'overrides:');
  }

  let overridesEnd = lines.findIndex((line, index) => index > overridesStart && /^\S/.test(line));
  if (overridesEnd === -1) overridesEnd = lines.length;

  const ownedNames = new Set(Object.keys(OVERRIDES));
  const retained = lines.slice(overridesStart + 1, overridesEnd).filter((line) => {
    const match = /^\s{2}["']?([^"':]+)["']?:/.exec(line);
    return !match || !ownedNames.has(match[1]);
  });
  while (retained.at(-1)?.trim() === '') retained.pop();
  if (operation === 'link') {
    retained.push(...Object.entries(OVERRIDES).map(([name, spec]) => `  "${name}": "${spec}"`));
  }
  retained.push('');
  lines.splice(overridesStart + 1, overridesEnd - overridesStart - 1, ...retained);

  const result = lines.join(newline);
  return hadFinalNewline ? `${result}${newline}` : result;
}
