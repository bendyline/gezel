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

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputFlag = process.argv.indexOf('--output');
const suppliedOutput = outputFlag === -1 ? null : process.argv[outputFlag + 1];
if (outputFlag !== -1 && !suppliedOutput) throw new Error('--output requires a directory path');

const packageDirs = [
  'core',
  'client',
  'sdk',
  'app-sdk',
  'plugin-sdk',
  'catalog',
  'mcp',
  'service',
  'connectors-spectral',
  'script-stdlib',
  'cli',
];
const packageNames = packageDirs.map((dir) => {
  const manifest = JSON.parse(
    readFileSync(resolve(repoRoot, 'packages', dir, 'package.json'), 'utf8'),
  );
  return manifest.name;
});
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
const originalSource = readFileSync(sourcePath, 'utf8');

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

let failed = false;
try {
  console.log(`rehearsal: stamping @bendyline/gezel ${coreVersion}`);
  run(process.execPath, [resolve(repoRoot, 'scripts/prepare-package.mjs'), coreVersion], {
    cwd: resolve(repoRoot, 'packages/core'),
    stdio: 'inherit',
  });

  console.log(`rehearsal: packing ${packageNames.length} packages to ${outputDir}`);
  run(
    'pnpm',
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
  const restore = spawnSync('pnpm', ['--filter', '@bendyline/gezel', 'run', 'build'], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  if (restore.error || restore.status !== 0) {
    failed = true;
    console.error(
      `rehearsal: failed to restore the development core build (${restore.error?.message ?? restore.status})`,
    );
  }
  if (temporaryRoot) rmSync(temporaryRoot, { recursive: true, force: true });
}

if (failed) process.exit(1);
