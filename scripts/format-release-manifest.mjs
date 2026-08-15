#!/usr/bin/env node
/**
 * Restore Biome formatting after semantic-release stamps a package version.
 *
 * `@semantic-release/npm` serializes package.json with its own JSON writer,
 * which expands short arrays that Biome keeps on one line. The release commit
 * uses package.json as a git asset, so normalize it after npm's prepare hook
 * and before `@semantic-release/git` snapshots the file.
 *
 * semantic-release runs this with cwd set to the package directory.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = resolve(process.cwd(), 'package.json');

if (process.env.GEZEL_RELEASE_DRY_RUN === '1') {
  console.log(`format-release-manifest: [dry run] would format ${manifestPath}`);
  process.exit(0);
}

let biomeCli;
try {
  biomeCli = createRequire(import.meta.url).resolve('@biomejs/biome/bin/biome');
} catch (err) {
  console.error(`format-release-manifest: could not resolve Biome: ${err.message}`);
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  [biomeCli, 'format', '--write', '--config-path', repoRoot, manifestPath],
  {
    cwd: repoRoot,
    stdio: 'inherit',
  },
);

if (result.error) {
  console.error(`format-release-manifest: failed to run Biome: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) process.exit(result.status ?? 1);
