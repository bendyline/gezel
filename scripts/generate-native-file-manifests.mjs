#!/usr/bin/env node

/**
 * Generate the source-pinnable per-file integrity manifest for a merged
 * native release tree.
 *
 * Run after signing/notarization and after all per-engine artifacts have been
 * merged into `<root>/<platform-key>/`. The resulting JSON is published next
 * to SHA256SUMS and later embedded into the CLI by pin-native-release.mjs.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import {
  NATIVE_FILE_MANIFEST_SCHEMA_VERSION,
  assertNativeFileManifest,
  buildNativePlatformManifest,
  platformKeysFromRoot,
} from './native-file-manifest-lib.mjs';

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

const platformDirs = await platformKeysFromRoot(root);

const platforms = {};
for (const platformKey of platformDirs) {
  const dir = join(root, platformKey);
  platforms[platformKey] = await buildNativePlatformManifest({
    dir,
    platformKey,
    signatureFor(_name, path) {
      return platformKey.startsWith('win32-') &&
        isThirdPartyBinary(`native/build/${platformKey}/${path}`)
        ? 'vendor-hash-only'
        : platformKey.startsWith('win32-') || platformKey.startsWith('darwin-')
          ? 'bendyline'
          : 'hash-only';
    },
  });
}

const manifest = {
  schemaVersion: NATIVE_FILE_MANIFEST_SCHEMA_VERSION,
  release,
  platforms,
};
assertNativeFileManifest(manifest, { expectedRelease: release });

await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`[native-files] wrote ${output} (${Object.keys(platforms).length} platform keys)`);
