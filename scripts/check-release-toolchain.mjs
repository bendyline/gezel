#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
/**
 * Preflight for the npm release toolchain.
 *
 * `multi-semantic-release` sits on a fragile seam with `semantic-release`:
 *
 *   1. It depends on semantic-release through an open `>=19.0.5` range and
 *      declares no peerDependency, so a floating version in this repo can
 *      silently drift to a major it was never tested against.
 *   2. It deep-imports the PRIVATE path `semantic-release/lib/get-config`
 *      and, when that import throws, SWALLOWS the failure into stubs behind
 *      a `console.debug`. The release then completes having published
 *      nothing, with no error — the worst possible failure mode for a
 *      release pipeline.
 *
 * This script turns both into loud, early failures. Run it in the release
 * workflow before `multi-semantic-release`.
 *
 * If the deep import ever breaks for real, the maintained successor is
 * `@anolilab/multi-semantic-release`, which also has explicit support for
 * pnpm's `workspace:` protocol.
 */
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const failures = [];

const rootPkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'));
const devDeps = rootPkg.devDependencies ?? {};

const EXACT = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

for (const name of ['semantic-release', 'multi-semantic-release']) {
  const range = devDeps[name];
  if (!range) {
    failures.push(`${name} is not in the root devDependencies`);
    continue;
  }
  if (!EXACT.test(range)) {
    failures.push(
      [
        `${name} must be pinned to an exact x.y.z version (found ${JSON.stringify(range)}).`,
        'multi-semantic-release depends on semantic-release via an open range and declares',
        'no peerDependency, so only an exact pin keeps the pair in a tested combination.',
      ].join(' '),
    );
  }
}

try {
  require.resolve('semantic-release/lib/get-config');
} catch (err) {
  failures.push(
    [
      "multi-semantic-release deep-imports the private path 'semantic-release/lib/get-config'",
      `and it no longer resolves (${err.code ?? err.message}). msr swallows this into stubs,`,
      'so a release would silently publish nothing. Pin a compatible semantic-release, or',
      'switch to @anolilab/multi-semantic-release.',
    ].join(' '),
  );
}

for (const relativePath of [
  'scripts/prepare-package.mjs',
  'scripts/format-release-manifest.mjs',
  'scripts/publish-package.mjs',
  'scripts/release-package-state.mjs',
  'scripts/pnpm-cli.mjs',
  'scripts/workspace-dependencies.mjs',
  'scripts/check-workspace-dependencies.mjs',
  'scripts/rehearse-npm-release.mjs',
  'scripts/verify-published-npm-release.mjs',
]) {
  const path = resolve(repoRoot, relativePath);
  try {
    readFileSync(path);
  } catch {
    failures.push(`missing ${path} — required by the npm release dependency/version boundary`);
  }
}

for (const relativePath of [
  'scripts/prepare-package.mjs',
  'scripts/rehearse-npm-release.mjs',
  'scripts/publish-package.mjs',
]) {
  try {
    const source = readFileSync(resolve(repoRoot, relativePath), 'utf8');
    if (!source.includes('spawnPnpmSync')) {
      failures.push(`${relativePath} must use the cross-platform synchronous pnpm launcher`);
    }
    if (/spawnSync\(\s*['"]pnpm['"]/.test(source)) {
      failures.push(
        `${relativePath} must not spawn the Windows pnpm.cmd shim as a bare executable`,
      );
    }
  } catch (err) {
    failures.push(`could not validate pnpm spawning in ${relativePath}: ${err.message}`);
  }
}

const consumerArgCheck = spawnSync(
  process.execPath,
  [resolve(repoRoot, 'scripts/check-package-consumers.mjs'), 'unexpected-positional-argument'],
  { cwd: repoRoot, encoding: 'utf8' },
);
if (
  consumerArgCheck.status !== 1 ||
  !consumerArgCheck.stderr.includes('unexpected argument "unexpected-positional-argument"')
) {
  failures.push(
    'check-package-consumers.mjs must reject unexpected positional arguments instead of silently repacking the workspace',
  );
}

try {
  const config = JSON.parse(readFileSync(resolve(repoRoot, '.releaserc.json'), 'utf8'));
  const npmIndex = config.plugins.findIndex(
    (plugin) => Array.isArray(plugin) && plugin[0] === '@semantic-release/npm',
  );
  const execIndex = config.plugins.findIndex(
    (plugin) => Array.isArray(plugin) && plugin[0] === '@semantic-release/exec',
  );
  const gitIndex = config.plugins.findIndex(
    (plugin) => Array.isArray(plugin) && plugin[0] === '@semantic-release/git',
  );
  const githubIndex = config.plugins.findIndex(
    (plugin) => Array.isArray(plugin) && plugin[0] === '@semantic-release/github',
  );
  const exec = config.plugins[execIndex]?.[1] ?? {};

  if (!/scripts\/prepare-package\.mjs \$\{nextRelease\.version\}/.test(exec.prepareCmd ?? '')) {
    failures.push(
      '.releaserc.json must run prepare-package.mjs so local dependencies return to workspace:* before commit',
    );
  }
  if (!/scripts\/publish-package\.mjs/.test(exec.publishCmd ?? '')) {
    failures.push('.releaserc.json must publish through publish-package.mjs / pnpm publish');
  }
  if (!/scripts\/format-release-manifest\.mjs/.test(exec.prepareCmd ?? '')) {
    failures.push(
      '.releaserc.json must format package.json after semantic-release stamps it and before the release commit',
    );
  }
  if (npmIndex < 0 || npmIndex >= execIndex) {
    failures.push(
      '.releaserc.json must run @semantic-release/npm before @semantic-release/exec so package versions are stamped before normalization',
    );
  }
  if (execIndex < 0 || gitIndex < 0 || execIndex >= gitIndex) {
    failures.push(
      '.releaserc.json must run @semantic-release/exec before @semantic-release/git so concrete local versions are never committed',
    );
  }
  if (githubIndex >= 0) {
    failures.push(
      '.releaserc.json must not create one GitHub Release per npm package; npm, changelogs, and git tags are the package release surfaces',
    );
  }
} catch (err) {
  failures.push(`could not validate .releaserc.json: ${err.message}`);
}

try {
  const workflow = readFileSync(resolve(repoRoot, '.github/workflows/publish-npm.yml'), 'utf8');
  if (!workflow.includes('pnpm check:workspace-deps')) {
    failures.push('publish-npm.yml must verify the workspace dependency invariant after release');
  }
  if (!workflow.includes('pnpm install --lockfile-only --frozen-lockfile')) {
    failures.push('publish-npm.yml must verify frozen lockfile consistency after release');
  }
  if (!workflow.includes('node scripts/rehearse-npm-release.mjs')) {
    failures.push('publish-npm.yml must rehearse release-stamped tarballs before publishing');
  }
  if (!workflow.includes('node scripts/verify-published-npm-release.mjs')) {
    failures.push('publish-npm.yml must verify exact registry artifacts after publishing');
  }
  if (/^\s*args=.*--sequential-prepare/m.test(workflow)) {
    failures.push(
      'publish-npm.yml passes unsupported --sequential-prepare; preserve computed dependency versions through the release-state bridge instead',
    );
  }
} catch (err) {
  failures.push(`could not validate publish-npm.yml: ${err.message}`);
}

if (failures.length > 0) {
  console.error('release toolchain check failed:\n');
  for (const failure of failures) console.error(`  - ${failure}\n`);
  process.exit(1);
}

console.log('release toolchain OK');
