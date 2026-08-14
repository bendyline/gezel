#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runLockfileRefreshAndInstall, withPnpmInstallLock } from './pnpm-install.mjs';

const mode = process.argv[2];
if (mode !== 'link' && mode !== 'unlink') {
  console.error('Usage: squisq-link.mjs <link|unlink>');
  process.exit(1);
}

const OVERRIDES = {
  '@bendyline/squisq': 'link:../squisq/packages/core',
  '@bendyline/squisq-editor-react': 'link:../squisq/packages/editor-react',
  '@bendyline/squisq-react': 'link:../squisq/packages/react',
  '@bendyline/squisq-formats': 'link:../squisq/packages/formats',
};

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '..');
const pkgPath = join(repoRoot, 'package.json');
const workspacePath = join(repoRoot, 'pnpm-workspace.yaml');
const squisqRoot = resolve(repoRoot, '..', 'squisq');

if (mode === 'link') {
  if (!existsSync(squisqRoot)) {
    console.error(`[squisq] expected sibling checkout at ${squisqRoot} - clone it first`);
    process.exit(1);
  }
  for (const [name, spec] of Object.entries(OVERRIDES)) {
    const target = resolve(repoRoot, spec.replace(/^link:/, ''));
    if (!existsSync(join(target, 'package.json'))) {
      console.error(`[squisq] missing ${name} at ${target}`);
      process.exit(1);
    }
  }

  // A link: dependency exposes the package directory immediately. Build every
  // linked package before changing pnpm's resolution so Gezel never starts
  // against a missing or half-written dist tree. This is especially important
  // for tsup's multi-entry output: an entry can briefly reference a chunk that
  // has not been emitted yet while a clean build is in progress.
  const buildScripts = ['build:core', 'build:formats', 'build:react', 'build:editor'];
  console.log('[squisq] building linked packages before activating local resolution');
  for (const script of buildScripts) {
    const build = spawnSync('npm', ['run', script], {
      stdio: 'inherit',
      cwd: squisqRoot,
      shell: process.platform === 'win32',
    });
    if (build.status !== 0) {
      console.error(`[squisq] ${script} failed - local resolution was not changed`);
      process.exit(build.status ?? 1);
    }
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

    // JSON.stringify always expands arrays one-element-per-line, but biome's
    // formatter wants short arrays inline (line width 100). Without this
    // pass, every link/unlink leaves package.json failing `pnpm lint`.
    if (legacyChanged) {
      const fmt = spawnSync('pnpm', ['exec', 'biome', 'format', '--write', 'package.json'], {
        stdio: 'inherit',
        cwd: repoRoot,
        shell: process.platform === 'win32',
      });
      if (fmt.status !== 0) {
        console.error('[squisq] biome format failed - package.json may be lint-dirty');
        return fmt.status ?? 1;
      }
    }

    if (!legacyChanged && !workspaceChanged) {
      console.log(
        mode === 'link'
          ? '[squisq] local resolution already active - reconciling the lockfile and install'
          : '[squisq] already unlinked - reconciling the lockfile and install',
      );
    } else {
      console.log(
        mode === 'link'
          ? '[squisq] linked local packages via pnpm-workspace.yaml overrides'
          : '[squisq] removed squisq overrides - reinstalling from registry',
      );
    }

    return runLockfileRefreshAndInstall({ repoRoot, setChildPid });
  },
  { command: `pnpm ${mode}:squisq` },
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
