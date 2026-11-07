#!/usr/bin/env node
/**
 * Refuse a release asset GitHub will not accept, before it is signed,
 * notarized, attested or uploaded.
 *
 * GitHub rejects any release asset of 2 GiB or more, and nothing else in the
 * pipeline knows that: electron-builder, dpkg and upload-artifact all take a
 * larger file without a word. The installers carry every native engine for
 * their platform, so each new engine key lands in them in full. ROCm in
 * native-v0.1.61 adds ~300 MiB to the Linux x64 installers and puts the amd64
 * .deb within ~120 MiB of the limit. Past it, the release job would fail at
 * upload, after every platform had already been built, signed and notarized.
 *
 * Each build job runs this on its own installers right after packaging, and
 * the release job runs it again on everything it is about to publish. Above
 * WARN_FRACTION of the limit it prints a warning, so the next engine is
 * planned for rather than discovered.
 *
 * Usage: node scripts/check-release-asset-sizes.mjs <file>...
 */
import { statSync } from 'node:fs';
import { basename } from 'node:path';

/** GitHub's per-asset limit: "each file included in a release must be under 2 GiB". */
export const GITHUB_RELEASE_ASSET_LIMIT = 2 * 1024 ** 3;
export const WARN_FRACTION = 0.9;

const mib = (bytes) => `${Math.round(bytes / 1024 / 1024)} MiB`;

/**
 * @param {{ name: string, bytes: number }[]} assets
 * @returns {{ name: string, bytes: number, level: 'ok' | 'warning' | 'error', message: string }[]}
 */
export function assessAssetSizes(assets, limit = GITHUB_RELEASE_ASSET_LIMIT) {
  return assets.map(({ name, bytes }) => {
    const headroom = limit - bytes;
    if (headroom <= 0) {
      return {
        name,
        bytes,
        level: 'error',
        message: `${name} is ${mib(bytes)}, ${mib(-headroom)} over GitHub's ${mib(limit)} release asset limit. GitHub will refuse the upload. Shrink the installer (the native engine keys it bundles are the bulk of it) before releasing.`,
      };
    }
    if (bytes >= limit * WARN_FRACTION) {
      return {
        name,
        bytes,
        level: 'warning',
        message: `${name} is ${mib(bytes)}, ${mib(headroom)} under GitHub's ${mib(limit)} release asset limit. The next native engine added to this installer may not fit.`,
      };
    }
    return {
      name,
      bytes,
      level: 'ok',
      message: `${name}: ${mib(bytes)} (${mib(headroom)} under the limit)`,
    };
  });
}

function main() {
  const paths = process.argv.slice(2);
  if (paths.length === 0) {
    console.error('usage: check-release-asset-sizes.mjs <file>...');
    process.exit(2);
  }
  const results = assessAssetSizes(
    paths.map((path) => ({ name: basename(path), bytes: statSync(path).size })),
  );
  for (const result of results) {
    if (result.level === 'ok') console.log(result.message);
    else console.log(`::${result.level}::${result.message}`);
  }
  if (results.some((result) => result.level === 'error')) process.exit(1);
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith(basename(import.meta.url))
) {
  main();
}
