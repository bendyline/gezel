#!/usr/bin/env node
/** Download the exact just-released package versions and rerun the strict
 * clean-consumer contract against registry bytes, not the checkout. */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PUBLISHED_PACKAGE_DIRS, readPublishedManifest } from './published-packages.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const maxAttempts = 21;
const retryDelayMs = 15_000;

export function verifyPublishedNpmRelease({
  spawn = spawnSync,
  wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
  log = console.log,
} = {}) {
  const specs = PUBLISHED_PACKAGE_DIRS.map((dir) => {
    const manifest = readPublishedManifest(repoRoot, dir);
    return `${manifest.name}@${manifest.version}`;
  });
  const root = mkdtempSync(resolve(tmpdir(), 'gezel-published-release-'));
  const tarballDir = resolve(root, 'tarballs');
  const cacheDir = resolve(root, 'npm-cache');

  function run(command, args) {
    const result = spawn(command, args, {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    return result;
  }

  try {
    mkdirSync(tarballDir, { recursive: true });
    let packed;
    // npm acknowledged the SDK publish before its version became readable in
    // the 2026-09-05 release. Allow five minutes of retries and revalidate cached
    // metadata each time; the previous 45-second window failed a valid release.
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      packed = run('npm', [
        'pack',
        '--pack-destination',
        tarballDir,
        '--cache',
        cacheDir,
        '--prefer-online',
        ...specs,
      ]);
      if (packed.status === 0) break;
      if (attempt < maxAttempts) {
        log(
          `registry verification: exact artifacts not ready (attempt ${attempt}/${maxAttempts}); retrying in ${retryDelayMs / 1000}s`,
        );
        wait(retryDelayMs);
      }
    }
    if (packed?.status !== 0) {
      throw new Error(
        `could not download the exact published artifacts after ${maxAttempts} attempts (${packed?.status ?? 1})`,
      );
    }

    const consumer = run(process.execPath, [
      resolve(repoRoot, 'scripts/check-package-consumers.mjs'),
      '--tarball-dir',
      tarballDir,
      '--require-release-stamp',
    ]);
    if (consumer.status !== 0) {
      throw new Error(`published artifact consumer checks failed (${consumer.status ?? 1})`);
    }
    log(`registry verification: ${specs.length} exact published artifacts passed`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  verifyPublishedNpmRelease();
}
