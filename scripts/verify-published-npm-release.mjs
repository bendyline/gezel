#!/usr/bin/env node
/** Download the exact just-released package versions and rerun the strict
 * clean-consumer contract against registry bytes, not the checkout. */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
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
const specs = packageDirs.map((dir) => {
  const manifest = JSON.parse(
    readFileSync(resolve(repoRoot, 'packages', dir, 'package.json'), 'utf8'),
  );
  return `${manifest.name}@${manifest.version}`;
});

const root = mkdtempSync(resolve(tmpdir(), 'gezel-published-release-'));
const tarballDir = resolve(root, 'tarballs');
const cacheDir = resolve(root, 'npm-cache');
mkdirSync(tarballDir, { recursive: true });

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  return result;
}

try {
  let packed;
  // npm's package document and CDN can lag publication briefly. Retry the
  // complete exact-version fetch rather than accidentally accepting `latest`.
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    packed = run('npm', ['pack', '--pack-destination', tarballDir, '--cache', cacheDir, ...specs], {
      stdio: 'inherit',
    });
    if (packed.status === 0) break;
    if (attempt < 4) {
      console.log(`registry verification: exact artifacts not ready (attempt ${attempt}/4)`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15_000);
    }
  }
  if (packed?.status !== 0) {
    throw new Error(`could not download the exact published artifacts (${packed?.status ?? 1})`);
  }

  const consumer = run(
    process.execPath,
    [
      resolve(repoRoot, 'scripts/check-package-consumers.mjs'),
      '--tarball-dir',
      tarballDir,
      '--require-release-stamp',
    ],
    { stdio: 'inherit' },
  );
  if (consumer.status !== 0) {
    throw new Error(`published artifact consumer checks failed (${consumer.status ?? 1})`);
  }
  console.log(`registry verification: ${specs.length} exact published artifacts passed`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
