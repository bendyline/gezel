#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runLockfileRefreshAndInstall, withPnpmInstallLock } from './pnpm-install.mjs';

const GILDE_PACKAGE = '@bendyline/gilde';
const CATALOG_PACKAGE = '@bendyline/gezel-catalog';
const VERSION_PATTERN =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '..');
const catalogDir = join(repoRoot, 'packages', 'catalog');
const catalogPackagePath = join(catalogDir, 'package.json');
const workspacePath = join(repoRoot, 'pnpm-workspace.yaml');
const lockfilePath = join(repoRoot, 'pnpm-lock.yaml');
const installedPackagePath = join(catalogDir, 'node_modules', GILDE_PACKAGE, 'package.json');

export function parseLatestVersion(output) {
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error(`npm returned invalid JSON for ${GILDE_PACKAGE}: ${output.trim()}`);
  }
  if (typeof parsed !== 'string' || !VERSION_PATTERN.test(parsed)) {
    throw new Error(
      `npm returned an invalid latest version for ${GILDE_PACKAGE}: ${output.trim()}`,
    );
  }
  return parsed;
}

export function readPinnedDependency(source) {
  const escapedName = escapeRegExp(GILDE_PACKAGE);
  const matches = [
    ...source.matchAll(
      new RegExp(`^([\\t ]*"${escapedName}"[\\t ]*:[\\t ]*")([^"]+)(",?[\\t ]*)$`, 'gm'),
    ),
  ];
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one ${GILDE_PACKAGE} dependency in packages/catalog/package.json, found ${matches.length}`,
    );
  }
  const version = matches[0][2];
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`${GILDE_PACKAGE} must use an exact version, found ${version}`);
  }
  return version;
}

export function updatePinnedDependency(source, version) {
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`cannot pin invalid ${GILDE_PACKAGE} version: ${version}`);
  }
  readPinnedDependency(source);
  const pattern = new RegExp(
    `^([\\t ]*"${escapeRegExp(GILDE_PACKAGE)}"[\\t ]*:[\\t ]*")([^"]+)(",?[\\t ]*)$`,
    'm',
  );
  return source.replace(
    pattern,
    (_match, before, _current, after) => `${before}${version}${after}`,
  );
}

export function hasPackageWideAgeExemption(source) {
  return minimumReleaseAgeSelectors(source).includes(GILDE_PACKAGE);
}

export function hasLocalGildeOverride(source) {
  return new RegExp(`^[ ]{2}["']?${escapeRegExp(GILDE_PACKAGE)}["']?:[\\t ]*["']?link:`, 'm').test(
    source,
  );
}

export function assertLockfileVersion(source, version) {
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`cannot verify invalid ${GILDE_PACKAGE} version: ${version}`);
  }

  const importerStart = source.indexOf('\n  packages/catalog:\n');
  if (importerStart === -1) {
    throw new Error('pnpm-lock.yaml has no packages/catalog importer');
  }
  const importerEnd = source.indexOf('\n  packages/', importerStart + 1);
  const importer = source.slice(importerStart, importerEnd === -1 ? source.length : importerEnd);
  const escapedVersion = escapeRegExp(version);
  const importerPattern = new RegExp(
    `\\n      '${escapeRegExp(GILDE_PACKAGE)}':\\n        specifier: ${escapedVersion}\\n        version: ${escapedVersion}(?:\\n|$)`,
  );
  if (!importerPattern.test(importer)) {
    throw new Error(`pnpm-lock.yaml catalog importer is not pinned to ${GILDE_PACKAGE}@${version}`);
  }

  const lockedVersions = new Set(
    [...source.matchAll(/^ {2}'@bendyline\/gilde@([^']+)':/gm)].map((match) => match[1]),
  );
  if (lockedVersions.size !== 1 || !lockedVersions.has(version)) {
    const found = [...lockedVersions].join(', ') || 'none';
    throw new Error(
      `pnpm-lock.yaml contains unexpected ${GILDE_PACKAGE} versions: ${found}; expected only ${version}`,
    );
  }
}

async function main() {
  if (process.argv.length > 2) {
    throw new Error('usage: pnpm gilde:update');
  }

  const [catalogSource, workspaceSource] = await Promise.all([
    readFile(catalogPackagePath, 'utf8'),
    readFile(workspacePath, 'utf8'),
  ]);
  const current = readPinnedDependency(catalogSource);

  if (!hasPackageWideAgeExemption(workspaceSource)) {
    throw new Error(
      `${workspacePath} must exempt "${GILDE_PACKAGE}" by package name before updating`,
    );
  }
  if (hasLocalGildeOverride(workspaceSource)) {
    throw new Error('local Gilde linking is active; run "pnpm unlink:gilde" before updating');
  }

  console.log(`[gilde:update] checking npm (current: ${current})`);
  const latest = queryLatestVersion();
  if (current === latest) {
    console.log(`[gilde:update] ${GILDE_PACKAGE}@${latest} is already current`);
    return;
  }

  const updated = await withPnpmInstallLock(
    repoRoot,
    async ({ setChildPid }) => {
      // Re-read after acquiring the lock. A link/unlink or another Gilde update
      // may have completed while the registry query or lock wait was in flight.
      const [lockedCatalogSource, lockedWorkspaceSource] = await Promise.all([
        readFile(catalogPackagePath, 'utf8'),
        readFile(workspacePath, 'utf8'),
      ]);
      const lockedCurrent = readPinnedDependency(lockedCatalogSource);
      if (!hasPackageWideAgeExemption(lockedWorkspaceSource)) {
        throw new Error(
          `${workspacePath} must exempt "${GILDE_PACKAGE}" by package name before updating`,
        );
      }
      if (hasLocalGildeOverride(lockedWorkspaceSource)) {
        throw new Error('local Gilde linking is active; run "pnpm unlink:gilde" before updating');
      }
      if (lockedCurrent === latest) {
        console.log(`[gilde:update] ${GILDE_PACKAGE}@${latest} was updated by another task`);
        return false;
      }

      await writeFile(
        catalogPackagePath,
        updatePinnedDependency(lockedCatalogSource, latest),
        'utf8',
      );
      console.log(`[gilde:update] updating ${lockedCurrent} -> ${latest}`);

      const installStatus = await runLockfileRefreshAndInstall({
        repoRoot,
        args: ['--filter', CATALOG_PACKAGE],
        setChildPid,
      });
      if (installStatus !== 0) {
        throw new Error(
          `refreshing the lockfile and installed package failed with exit code ${installStatus}`,
        );
      }

      await verifyInstalledVersion(latest);
      return true;
    },
    { command: 'pnpm gilde:update' },
  );
  if (!updated) return;

  run(
    process.execPath,
    [
      join(catalogDir, 'node_modules', 'typescript', 'bin', 'tsc'),
      '--noEmit',
      '-p',
      join(catalogDir, 'tsconfig.json'),
    ],
    {
      cwd: repoRoot,
      label: 'typechecking the catalog',
    },
  );
  run(
    process.execPath,
    [
      join(catalogDir, 'node_modules', 'typescript', 'bin', 'tsc'),
      '--noEmit',
      '-p',
      join(catalogDir, 'scripts', 'tsconfig.json'),
    ],
    {
      cwd: repoRoot,
      label: 'typechecking catalog authoring scripts',
    },
  );
  run(
    process.execPath,
    [join(catalogDir, 'node_modules', 'vitest', 'vitest.mjs'), 'run', '--passWithNoTests'],
    {
      cwd: catalogDir,
      label: 'running catalog tests',
    },
  );
  run(process.execPath, ['--test', join(scriptsDir, 'update-gilde.test.mjs')], {
    cwd: repoRoot,
    label: 'testing the updater',
  });

  console.log(`[gilde:update] updated and verified ${GILDE_PACKAGE}@${latest}`);
}

function queryLatestVersion() {
  const result = spawnSync('npm', ['view', `${GILDE_PACKAGE}@latest`, 'version', '--json'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: npmEnvironment(),
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`npm view failed with exit code ${result.status ?? 'unknown'}`);
  }
  return parseLatestVersion(result.stdout);
}

async function verifyInstalledVersion(expected) {
  const [catalogSource, lockfileSource, installedSource] = await Promise.all([
    readFile(catalogPackagePath, 'utf8'),
    readFile(lockfilePath, 'utf8'),
    readFile(installedPackagePath, 'utf8'),
  ]);
  const manifestVersion = readPinnedDependency(catalogSource);
  const installedVersion = JSON.parse(installedSource).version;
  if (manifestVersion !== expected) {
    throw new Error(
      `catalog manifest resolved to ${manifestVersion}; expected ${GILDE_PACKAGE}@${expected}`,
    );
  }
  if (installedVersion !== expected) {
    throw new Error(
      `installed package resolved to ${installedVersion}; expected ${GILDE_PACKAGE}@${expected}`,
    );
  }
  assertLockfileVersion(lockfileSource, expected);
}

function run(command, args, { cwd, label }) {
  console.log(`[gilde:update] ${label}`);
  const result = spawnSync(command, args, {
    cwd,
    shell: process.platform === 'win32' && command !== process.execPath,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status ?? 'unknown'}`);
  }
}

function minimumReleaseAgeSelectors(source) {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => /^minimumReleaseAgeExclude:\s*$/.test(line));
  if (start === -1) return [];
  const selectors = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const match = /^\s+-\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    selectors.push(unquoteYamlScalar(match[1]));
  }
  return selectors;
}

function unquoteYamlScalar(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function npmEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'npm_config_manage_package_manager_versions') delete env[key];
  }
  return env;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((error) => {
    console.error(`[gilde:update] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
