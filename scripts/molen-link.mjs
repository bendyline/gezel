#!/usr/bin/env node
// Links @bendyline/molen-stage, which the service uses to check the films,
// games and scenes a gezel writes, from the sibling ../molen checkout.
//
// Until its first npm release the service does not declare it at all: a
// version in package.json that the registry lacks is skipped by an ordinary
// install but fails every `pnpm install --frozen-lockfile` (CI, the service
// bundle), because the lockfile can never record it. So `link` adds it to the
// service's optionalDependencies as a `link:` dependency and `unlink` removes
// it, and without it the service runs with no Molen checks. After the release,
// declare the published version for good and make this an override script
// like squisq-link.mjs.
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

const PACKAGE = '@bendyline/molen-stage';
/** Relative to packages/service, where the dependency is declared. */
const LINK_SPEC = 'link:../../../molen/packages/stage';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '..');
const serviceDir = join(repoRoot, 'packages', 'service');
const servicePkgPath = join(serviceDir, 'package.json');
const workspacePath = join(repoRoot, 'pnpm-workspace.yaml');
const molenRoot = resolve(repoRoot, '..', 'molen');

if (mode === 'link') {
  const target = resolve(serviceDir, LINK_SPEC.slice('link:'.length));
  const pkgPath = join(target, 'package.json');
  if (!existsSync(pkgPath)) {
    console.error(
      `[molen] missing ${PACKAGE} at ${target} - clone the molen checkout beside gezel`,
    );
    process.exit(1);
  }
  if (JSON.parse(readFileSync(pkgPath, 'utf8')).name !== PACKAGE) {
    console.error(`[molen] ${target} is not the ${PACKAGE} package`);
    process.exit(1);
  }
  // Replacing a published version would lose it on unlink.
  const declared = JSON.parse(readFileSync(servicePkgPath, 'utf8')).optionalDependencies?.[PACKAGE];
  if (declared !== undefined && !String(declared).startsWith('link:')) {
    console.error(
      `[molen] the service declares ${PACKAGE} at ${declared}; link a published version through a workspace override instead (see squisq-link.mjs)`,
    );
    process.exit(1);
  }

  // A link: dependency exposes the package directory immediately, so build it
  // (and the Molen packages it depends on) before changing pnpm's resolution:
  // the service must never start against a missing or stale dist tree.
  console.log('[molen] building molen-stage and its dependencies before linking');
  const build = spawnSync('pnpm', ['--filter', `${PACKAGE}...`, 'build'], {
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
    const pkgRaw = await readFile(servicePkgPath, 'utf8');
    const nextPkg = updateServiceManifest(pkgRaw, mode);
    if (nextPkg !== pkgRaw) await writeFile(servicePkgPath, nextPkg);

    // Earlier versions of this script linked through a workspace override.
    const workspaceRaw = await readFile(workspacePath, 'utf8');
    const nextWorkspace = removeWorkspaceOverride(workspaceRaw);
    if (nextWorkspace !== workspaceRaw) await writeFile(workspacePath, nextWorkspace);

    if (nextPkg === pkgRaw && nextWorkspace === workspaceRaw) {
      console.log(
        mode === 'link'
          ? '[molen] already linked - reconciling the lockfile and install'
          : '[molen] already unlinked - reconciling the lockfile and install',
      );
    } else if (mode === 'link') {
      console.log(`[molen] the service now depends on the local ${PACKAGE}`);
    } else {
      console.log(`[molen] removed ${PACKAGE}; Molen documents go unchecked until it is linked`);
    }

    return runLockfileRefreshAndInstall({ repoRoot, setChildPid });
  },
  { command: `pnpm ${mode}:molen` },
);
process.exitCode = installStatus;

/**
 * Edits the manifest's text rather than rewriting it from JSON, which would
 * re-wrap every array Biome keeps on one line. The result is parsed back and
 * refused unless the dependency is the only thing that changed.
 */
function updateServiceManifest(source, operation) {
  const pkg = JSON.parse(source);
  const current = pkg.optionalDependencies?.[PACKAGE];
  if (operation === 'link' && current === LINK_SPEC) return source;
  // Only a link is ours to remove; a published version declared here stays.
  if (operation === 'unlink' && (current === undefined || !String(current).startsWith('link:'))) {
    return source;
  }

  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.split(/\r?\n/);
  const blockStart = lines.findIndex((line) => /^ {2}"optionalDependencies": \{\s*$/.test(line));
  const closeAfter = (start) => lines.findIndex((line, i) => i > start && /^ {2}\}/.test(line));
  const entryAt = lines.findIndex(
    (line, i) =>
      blockStart !== -1 && i > blockStart && line.trimStart().startsWith(`"${PACKAGE}":`),
  );
  const dropTrailingComma = (i) => {
    lines[i] = lines[i].replace(/,(\s*)$/, '$1');
  };

  if (operation === 'link') {
    const entry = `    "${PACKAGE}": "${LINK_SPEC}"`;
    if (entryAt !== -1) {
      lines[entryAt] = lines[entryAt].replace(/:\s*"[^"]*"/, `: "${LINK_SPEC}"`);
    } else if (blockStart !== -1) {
      const empty = closeAfter(blockStart) === blockStart + 1;
      lines.splice(blockStart + 1, 0, empty ? entry : `${entry},`);
    } else {
      const deps = lines.findIndex((line) => /^ {2}"dependencies": \{\s*$/.test(line));
      if (deps === -1) throw new Error('[molen] the service manifest has no dependencies block');
      const close = closeAfter(deps);
      const last = !lines[close].trimEnd().endsWith(',');
      if (last) lines[close] = `${lines[close].trimEnd()},`;
      lines.splice(close + 1, 0, '  "optionalDependencies": {', entry, last ? '  }' : '  },');
    }
  } else if (Object.keys(pkg.optionalDependencies).length === 1) {
    const close = closeAfter(blockStart);
    if (!lines[close].trimEnd().endsWith(',')) dropTrailingComma(blockStart - 1);
    lines.splice(blockStart, close - blockStart + 1);
  } else {
    if (!lines[entryAt].trimEnd().endsWith(',')) dropTrailingComma(entryAt - 1);
    lines.splice(entryAt, 1);
  }

  const next = lines.join(newline);
  const expected = structuredClone(pkg);
  if (operation === 'link') {
    expected.optionalDependencies = { ...expected.optionalDependencies, [PACKAGE]: LINK_SPEC };
  } else {
    delete expected.optionalDependencies[PACKAGE];
    if (Object.keys(expected.optionalDependencies).length === 0) {
      delete expected.optionalDependencies;
    }
  }
  if (!sameJson(JSON.parse(next), expected)) {
    throw new Error(`[molen] could not ${operation} ${PACKAGE} in ${servicePkgPath} cleanly`);
  }
  return next;
}

/** Equal JSON values, ignoring the order of object keys. */
function sameJson(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => sameJson(v, b[i]))
    );
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((k) => sameJson(a[k], b[k]));
  }
  return a === b;
}

function removeWorkspaceOverride(source) {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => /^overrides:\s*$/.test(line));
  if (start === -1) return source;
  let end = lines.findIndex((line, index) => index > start && /^\S/.test(line));
  if (end === -1) end = lines.length;
  const kept = lines.filter((line, index) => {
    if (index <= start || index >= end) return true;
    const match = /^\s{2}["']?([^"':]+)["']?:/.exec(line);
    return match?.[1] !== PACKAGE;
  });
  return kept.length === lines.length ? source : kept.join(newline);
}
