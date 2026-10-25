#!/usr/bin/env node
/**
 * Copy native binaries built on this machine into packages/app/native-bin/
 * when the pinned native release does not carry them yet, so a local
 * packaged build can ship them before CI publishes the release that does.
 *
 * Usage:
 *   node scripts/stage-local-native.mjs           # stage, after fetch-native-binaries
 *   node scripts/stage-local-native.mjs --remove  # take them back out
 *
 * Only files the payload contract (scripts/native-payload.mjs) lists for one
 * of this host's keys, and the pinned release lacks, are eligible: a pinned
 * file is never replaced, so everything else in the package stays exactly as
 * the release built and signed it. Today that is `vec0.dll` (sqlite-vec) on
 * Windows on ARM.
 *
 * For packaging only. The pinned-file verifier rejects any file it has no
 * pin for, so after staging, dev launches (`pnpm app`) and the CLI see the
 * tree as unverified: ensure-native-binaries re-fetches the pinned release,
 * which wipes what this staged. In dev, point GEZEL_SQLITE_VEC_PATH at
 * native/build instead; the dev supervisor already prefers native/build for
 * engine executables.
 */
import { copyFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectPlatform, expectedBinaries, platformVariants } from './native-payload.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const buildRoot = join(repoRoot, 'native', 'build');
const nativeBinRoot = join(repoRoot, 'packages', 'app', 'native-bin');
const manifestPath = join(
  repoRoot,
  'packages',
  'inference',
  'src',
  'engines',
  'native-file-manifest.json',
);

const remove = process.argv.includes('--remove');
const pinned = JSON.parse(readFileSync(manifestPath, 'utf8')).release;
const platform = detectPlatform();
if (!platform) {
  console.error(`[stage-local-native] unsupported host: ${process.platform}/${process.arch}`);
  process.exit(1);
}

let changed = 0;
const notBuilt = [];
for (const key of platformVariants(platform)) {
  const inPinned = new Set(expectedBinaries(key, pinned));
  const unpinned = expectedBinaries(key).filter((name) => !inPinned.has(name));
  for (const name of unpinned) {
    const target = join(nativeBinRoot, key, name);
    if (remove) {
      if (existsSync(target)) {
        rmSync(target);
        console.log(`[stage-local-native] removed ${key}/${name}`);
        changed += 1;
      }
      continue;
    }
    const source = join(buildRoot, key, name);
    if (!existsSync(source)) {
      notBuilt.push(`${key}/${name}`);
      continue;
    }
    if (!existsSync(join(nativeBinRoot, key))) {
      console.error(
        `[stage-local-native] ${key} is not staged; run \`node scripts/fetch-native-binaries.mjs --version ${pinned}\` first`,
      );
      process.exit(1);
    }
    copyFileSync(source, target);
    console.log(
      `[stage-local-native] staged ${key}/${name} from native/build (not in pinned ${pinned})`,
    );
    changed += 1;
  }
}

if (notBuilt.length > 0) {
  console.log(
    `[stage-local-native] not built on this machine, so left out: ${notBuilt.join(', ')}`,
  );
}
if (changed === 0) {
  console.log(`[stage-local-native] nothing to ${remove ? 'remove' : 'stage'} for ${platform}`);
} else if (!remove) {
  console.log(
    '[stage-local-native] native-bin now differs from the pin: package, then run with --remove',
  );
}
