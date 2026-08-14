#!/usr/bin/env node
// Adapted from squisq-link.mjs for the @bendyline/gilde content package.
// Gilde is pure content (no build step), so there is no build-before-link
// pass; the only precondition is a healthy sibling checkout.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runLockfileRefreshAndInstall, withPnpmInstallLock } from './pnpm-install.mjs';

const mode = process.argv[2];
if (mode !== 'link' && mode !== 'unlink') {
  console.error('Usage: gilde-link.mjs <link|unlink>');
  process.exit(1);
}

const OVERRIDES = {
  '@bendyline/gilde': 'link:../gilde',
};

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '..');
const pkgPath = join(repoRoot, 'package.json');
const workspacePath = join(repoRoot, 'pnpm-workspace.yaml');
const gildeRoot = resolve(repoRoot, '..', 'gilde');

if (mode === 'link') {
  const gildePkgPath = join(gildeRoot, 'package.json');
  if (!existsSync(gildePkgPath)) {
    console.error(`[gilde] expected sibling checkout at ${gildeRoot} - clone it first:`);
    console.error('[gilde]   git clone https://github.com/bendyline/gilde.git');
    process.exit(1);
  }
  let name;
  try {
    name = JSON.parse(readFileSync(gildePkgPath, 'utf8')).name;
  } catch {
    name = undefined;
  }
  if (name !== '@bendyline/gilde') {
    console.error(`[gilde] ${gildeRoot} is not the @bendyline/gilde package (name: ${name})`);
    process.exit(1);
  }
}

const installStatus = await withPnpmInstallLock(
  repoRoot,
  async ({ setChildPid }) => {
    const pkgRaw = await readFile(pkgPath, 'utf8');
    const pkg = JSON.parse(pkgRaw);
    const workspaceRaw = await readFile(workspacePath, 'utf8');

    // pnpm 10.33 moved overrides to pnpm-workspace.yaml. Remove the legacy
    // package.json entries as part of either operation so older local checkouts
    // migrate automatically instead of printing an ignored-setting warning.
    const legacyBefore = JSON.stringify(pkg.pnpm?.overrides ?? {});
    for (const key of Object.keys(OVERRIDES)) delete pkg.pnpm?.overrides?.[key];
    if (pkg.pnpm?.overrides && Object.keys(pkg.pnpm.overrides).length === 0) {
      delete pkg.pnpm.overrides;
    }
    const legacyChanged = legacyBefore !== JSON.stringify(pkg.pnpm?.overrides ?? {});
    const nextWorkspace = updateWorkspaceOverrides(workspaceRaw, mode);
    const workspaceChanged = nextWorkspace !== workspaceRaw;

    if (legacyChanged) await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
    if (workspaceChanged) await writeFile(workspacePath, nextWorkspace);

    if (legacyChanged) {
      const fmt = spawnSync('pnpm', ['exec', 'biome', 'format', '--write', 'package.json'], {
        stdio: 'inherit',
        cwd: repoRoot,
        shell: process.platform === 'win32',
      });
      if (fmt.status !== 0) {
        console.error('[gilde] biome format failed - package.json may be lint-dirty');
        return fmt.status ?? 1;
      }
    }

    if (!legacyChanged && !workspaceChanged) {
      console.log(
        mode === 'link'
          ? '[gilde] local resolution already active - reconciling the lockfile and install'
          : '[gilde] already unlinked - reconciling the lockfile and install',
      );
    } else {
      console.log(
        mode === 'link'
          ? '[gilde] linked the local checkout via pnpm-workspace.yaml overrides'
          : '[gilde] removed the gilde override - reinstalling from the registry',
      );
    }
    if (mode === 'link') {
      console.log(
        '[gilde] after editing content, refresh the generated indexes with: pnpm --filter @bendyline/gezel-catalog build-index',
      );
    }

    return runLockfileRefreshAndInstall({ repoRoot, setChildPid });
  },
  { command: `pnpm ${mode}:gilde` },
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
