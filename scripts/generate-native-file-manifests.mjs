#!/usr/bin/env node

/**
 * Generate the source-pinnable per-file integrity manifest for a merged
 * native release tree.
 *
 * Run after signing/notarization and after all per-engine artifacts have been
 * merged into `<root>/<platform-key>/`. The resulting JSON is published next
 * to SHA256SUMS and later embedded into the CLI by pin-native-release.mjs.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, join, relative, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { isThirdPartyBinary } = require('../packages/app/scripts/third-party-binaries.cjs');

const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const root = resolve(value('--root') ?? 'native/build');
const output = resolve(value('--out') ?? 'release/NATIVE_FILE_MANIFESTS.json');
const release = (value('--version') ?? '').replace(/^native-v/, '').replace(/^v/, '');
if (!release) throw new Error('--version is required');

const platformDirs = (await readdir(root, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const platforms = {};
for (const platformKey of platformDirs) {
  const dir = join(root, platformKey);
  const files = {};
  for (const absolute of await walk(dir)) {
    const info = await stat(absolute);
    if (!isLoadableNativeFile(platformKey, absolute, info.mode)) continue;
    const path = relative(dir, absolute).replaceAll('\\', '/');
    const name = basename(absolute);
    files[path] = {
      sha256: await sha256File(absolute),
      sizeBytes: info.size,
      signature:
        platformKey.startsWith('win32-') && isThirdPartyBinary(name)
          ? 'vendor-hash-only'
          : platformKey.startsWith('win32-') || platformKey.startsWith('darwin-')
            ? 'bendyline'
            : 'hash-only',
    };
  }
  if (Object.keys(files).length === 0) {
    throw new Error(`${platformKey} contains no executable or loadable native files`);
  }
  platforms[platformKey] = { files };
}

await writeFile(
  output,
  `${JSON.stringify({ schemaVersion: 1, release, platforms }, null, 2)}\n`,
  'utf8',
);
console.log(`[native-files] wrote ${output} (${Object.keys(platforms).length} platform keys)`);

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`refusing symlink in native payload: ${path}`);
    if (entry.isDirectory()) out.push(...(await walk(path)));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

function isLoadableNativeFile(platformKey, path, mode) {
  const name = basename(path).toLowerCase();
  if (platformKey.startsWith('win32-')) return name.endsWith('.exe') || name.endsWith('.dll');
  if (platformKey.startsWith('darwin-')) {
    return name.endsWith('.dylib') || (mode & 0o111) !== 0;
  }
  return name.includes('.so') || (mode & 0o111) !== 0;
}

function sha256File(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolveHash(hash.digest('hex')));
  });
}
