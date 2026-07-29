#!/usr/bin/env node

/**
 * Verify a staged or packaged native tree against the source-bundled per-file
 * manifest. With no `--root`, this validates only the manifest schema and
 * release, which is useful in release preflight before artifacts are fetched.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assertNativeFileManifest, verifyNativeFileTree } from './native-file-manifest-lib.mjs';

const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const manifestPath = value('--manifest');
const root = value('--root');
const release = value('--release');
if (!manifestPath) {
  throw new Error(
    'usage: verify-native-file-manifest.mjs --manifest <json> [--release <version>] [--root <native-bin>]',
  );
}

const manifest = JSON.parse(await readFile(resolve(manifestPath), 'utf8'));
assertNativeFileManifest(manifest, { expectedRelease: release });

if (!root) {
  console.log(
    `[native-files] valid schema ${manifest.schemaVersion} manifest for ${manifest.release} (${Object.keys(manifest.platforms).length} platform keys)`,
  );
} else {
  const result = await verifyNativeFileTree({
    root,
    manifest,
    expectedRelease: release,
  });
  console.log(
    `[native-files] verified ${result.fileCount} files and ${result.symlinkCount} symlinks across ${result.platformCount} platform keys under ${resolve(root)}`,
  );
}
