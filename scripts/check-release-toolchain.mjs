#!/usr/bin/env node
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

const publishScript = resolve(repoRoot, 'scripts/publish-package.mjs');
try {
  readFileSync(publishScript);
} catch {
  failures.push(`missing ${publishScript} — .releaserc.json's exec publishCmd points at it`);
}

if (failures.length > 0) {
  console.error('release toolchain check failed:\n');
  for (const failure of failures) console.error(`  - ${failure}\n`);
  process.exit(1);
}

console.log('release toolchain OK');
