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
export const REGISTRY_AVAILABILITY_TIMEOUT_MS = 40 * 60_000;
export const REGISTRY_RETRY_DELAY_MS = 15_000;

export function verifyPublishedNpmRelease({
  spawn = spawnSync,
  wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
  now = Date.now,
  log = console.log,
  availabilityTimeoutMs = REGISTRY_AVAILABILITY_TIMEOUT_MS,
  retryDelayMs = REGISTRY_RETRY_DELAY_MS,
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
    const pending = new Set(specs);
    const startedAt = now();
    const deadline = startedAt + availabilityTimeoutMs;
    let attempt = 0;

    // npm scans every newly published package before making it installable.
    // Its documented typical delay is around five minutes, but scans can take
    // 15 minutes or more depending on registry load, package size, and content.
    // Pack each artifact separately so packages that clear scanning are saved
    // once instead of being downloaded again while a slower sibling is pending.
    while (pending.size > 0) {
      attempt += 1;
      for (const spec of pending) {
        const packed = run('npm', [
          'pack',
          '--pack-destination',
          tarballDir,
          '--cache',
          cacheDir,
          '--prefer-online',
          spec,
        ]);
        if (packed.status === 0) pending.delete(spec);
      }

      if (pending.size === 0) break;
      const remainingMs = deadline - now();
      if (remainingMs <= 0) break;
      const delayMs = Math.min(retryDelayMs, remainingMs);
      const elapsedSeconds = Math.round((now() - startedAt) / 1000);
      log(
        `registry verification: ${pending.size}/${specs.length} exact artifacts not ready after ${elapsedSeconds}s (attempt ${attempt}): ${[...pending].join(', ')}; retrying in ${delayMs / 1000}s`,
      );
      wait(delayMs);
    }

    if (pending.size > 0) {
      throw new Error(
        `could not download ${pending.size}/${specs.length} exact published artifacts within ${availabilityTimeoutMs / 60_000} minutes: ${[...pending].join(', ')}`,
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
