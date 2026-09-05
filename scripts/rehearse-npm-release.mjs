#!/usr/bin/env node
/**
 * Produce and exercise the same release-stamped tarballs npm receives.
 *
 * A normal `pnpm pack` is useful for checking package shape, but it cannot
 * prove the product version: source intentionally stays at GEZEL_VERSION
 * 0.0.0 and semantic-release stamps core only after it computes the release.
 * This rehearsal performs that stamp with the current package version, packs
 * all public packages, then runs the clean npm-consumer contract in strict
 * release mode. Source and dist are restored to development state afterward.
 *
 * Usage:
 *   node scripts/rehearse-npm-release.mjs
 *   node scripts/rehearse-npm-release.mjs --output artifacts/npm-release-candidate
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnPnpmSync } from './pnpm-cli.mjs';
import { publishedPackageNames } from './published-packages.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputFlag = process.argv.indexOf('--output');
const suppliedOutput = outputFlag === -1 ? null : process.argv[outputFlag + 1];
if (outputFlag !== -1 && !suppliedOutput) throw new Error('--output requires a directory path');

const packageNames = publishedPackageNames(repoRoot);
const coreVersion = JSON.parse(
  readFileSync(resolve(repoRoot, 'packages/core/package.json'), 'utf8'),
).version;

const temporaryRoot = suppliedOutput
  ? null
  : mkdtempSync(resolve(tmpdir(), 'gezel-npm-rehearsal-'));
const outputDir = resolve(repoRoot, suppliedOutput ?? resolve(temporaryRoot, 'tarballs'));
if (existsSync(outputDir) && readdirSync(outputDir).some((file) => file.endsWith('.tgz'))) {
  throw new Error(`${outputDir} already contains tarballs; use an empty output directory`);
}
mkdirSync(outputDir, { recursive: true });

const sourcePath = resolve(repoRoot, 'packages/core/src/index.ts');

/**
 * The development values of the two constants `prepare-package.mjs` stamps.
 * A checkout must carry these before the rehearsal begins and must carry them
 * again after it ends.
 */
const DEVELOPMENT_STAMP = {
  GEZEL_VERSION: '0.0.0',
  GEZEL_CONTENT_COMPAT: '0.0.0',
};

/** Read the stamped constants out of core's source. */
function readStamp(source) {
  return Object.fromEntries(
    Object.keys(DEVELOPMENT_STAMP).map((name) => [
      name,
      new RegExp(`export const ${name} = '([^']*)';`).exec(source)?.[1] ?? null,
    ]),
  );
}

function describeStamp(stamp) {
  return Object.entries(stamp)
    .map(([name, value]) => `${name} = ${value === null ? '(not found)' : `'${value}'`}`)
    .join(', ');
}

function isDevelopmentStamp(stamp) {
  return Object.entries(DEVELOPMENT_STAMP).every(([name, value]) => stamp[name] === value);
}

// The restore below cannot be "write back whatever was there at start-up".
// This script stamps a release version into a source constant that must never
// reach a commit, and an earlier interrupted run — or a manual
// `prepare-package.mjs` — leaves that constant already stamped. Trusting the
// start-up read then faithfully restores the stamped value and the rehearsal
// reports success while leaving a non-0.0.0 GEZEL_VERSION in the working
// tree. Refuse to start from anything but the development baseline, and the
// text captured here is known-good by construction.
const originalSource = readFileSync(sourcePath, 'utf8');
const originalStamp = readStamp(originalSource);
if (!isDevelopmentStamp(originalStamp)) {
  throw new Error(
    [
      `packages/core/src/index.ts is not at its development baseline (${describeStamp(originalStamp)}).`,
      'A previous release or rehearsal left it stamped. Restore it before rehearsing:',
      '  git checkout -- packages/core/src/index.ts && pnpm --filter @bendyline/gezel run build',
    ].join('\n'),
  );
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (${result.status})\n${result.stdout ?? ''}\n${result.stderr ?? ''}`,
    );
  }
  return result;
}

function runPnpm(args, options = {}) {
  const result = spawnPnpmSync(args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `pnpm ${args.join(' ')} failed (${result.status})\n${result.stdout ?? ''}\n${result.stderr ?? ''}`,
    );
  }
  return result;
}

let failed = false;
try {
  console.log(`rehearsal: stamping @bendyline/gezel ${coreVersion}`);
  run(process.execPath, [resolve(repoRoot, 'scripts/prepare-package.mjs'), coreVersion], {
    cwd: resolve(repoRoot, 'packages/core'),
    stdio: 'inherit',
  });

  console.log(`rehearsal: packing ${packageNames.length} packages to ${outputDir}`);
  runPnpm(
    [
      '--recursive',
      ...packageNames.flatMap((name) => ['--filter', name]),
      'pack',
      '--pack-destination',
      outputDir,
    ],
    { stdio: 'inherit' },
  );

  console.log('rehearsal: installing and exercising the strict release set');
  run(
    process.execPath,
    [
      resolve(repoRoot, 'scripts/check-package-consumers.mjs'),
      '--tarball-dir',
      outputDir,
      '--require-release-stamp',
    ],
    { stdio: 'inherit' },
  );
  console.log(`rehearsal: release candidate with core ${coreVersion} passed`);
} catch (err) {
  failed = true;
  console.error(err.message);
} finally {
  writeFileSync(sourcePath, originalSource, 'utf8');
  // Prove it rather than assume it: this constant reaching a commit is the
  // one outcome the whole guard exists to prevent.
  const restoredStamp = readStamp(readFileSync(sourcePath, 'utf8'));
  if (!isDevelopmentStamp(restoredStamp)) {
    failed = true;
    console.error(
      `rehearsal: packages/core/src/index.ts was left stamped (${describeStamp(restoredStamp)}) — run \`git checkout -- packages/core/src/index.ts\` before committing`,
    );
  }
  let restore;
  let restoreError;
  try {
    restore = spawnPnpmSync(['--filter', '@bendyline/gezel', 'run', 'build'], {
      cwd: repoRoot,
      stdio: 'inherit',
    });
    restoreError = restore.error;
  } catch (error) {
    restoreError = error;
  }
  if (restoreError || restore?.status !== 0) {
    failed = true;
    console.error(
      `rehearsal: failed to restore the development core build (${restoreError?.message ?? restore?.status})`,
    );
  }
  if (temporaryRoot) rmSync(temporaryRoot, { recursive: true, force: true });
}

if (failed) process.exit(1);
