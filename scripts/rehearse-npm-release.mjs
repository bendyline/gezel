#!/usr/bin/env node
/**
 * Produce and exercise the same release-stamped tarballs npm receives.
 *
 * A normal `pnpm pack` is useful for checking package shape, but it cannot
 * prove the product version: source stays at GEZEL_VERSION 0.0.0 and
 * semantic-release stamps core's build only after it computes the release.
 * This rehearsal performs that stamped build with the current package version,
 * packs all public packages, then runs the clean npm-consumer contract in
 * strict release mode. Core's dist is rebuilt for development afterward; its
 * source is never written, so a commit made mid-rehearsal cannot carry a stamp.
 *
 * Usage:
 *   node scripts/rehearse-npm-release.mjs
 *   node scripts/rehearse-npm-release.mjs --output artifacts/npm-release-candidate
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { consumerCheckFailureSummary, consumerCheckReportPath } from './consumer-check-report.mjs';
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

const consumerReport = consumerCheckReportPath(repoRoot);

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
let consumerStarted = false;
const failureMessages = [];
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
  consumerStarted = true;
  run(
    process.execPath,
    [
      resolve(repoRoot, 'scripts/check-package-consumers.mjs'),
      '--tarball-dir',
      outputDir,
      '--require-release-stamp',
    ],
    {
      stdio: 'inherit',
      env: { ...process.env, GEZEL_CONSUMER_REPORT_PATH: consumerReport },
    },
  );
  console.log(`rehearsal: release candidate with core ${coreVersion} passed`);
} catch (err) {
  failed = true;
  failureMessages.push(err.message);
  console.error(err.message);
} finally {
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
    const message = `rehearsal: failed to restore the development core build (${restoreError?.message ?? restore?.status})`;
    failureMessages.push(message);
    console.error(message);
  }
  if (temporaryRoot) rmSync(temporaryRoot, { recursive: true, force: true });
}

if (failed) {
  console.error('\nrehearsal: FAILED (the core rebuild above was cleanup)');
  for (const message of failureMessages) console.error(message);
  if (consumerStarted) console.error(consumerCheckFailureSummary(consumerReport));
  process.exit(1);
}
