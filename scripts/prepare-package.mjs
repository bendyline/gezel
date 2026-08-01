#!/usr/bin/env node
/**
 * Stamp the product version into `packages/core/src/index.ts` and rebuild core,
 * invoked by `@semantic-release/exec`'s `prepareCmd` once multi-semantic-release
 * has computed a package's next version.
 *
 * WHY THIS EXISTS: `GEZEL_VERSION` is a source constant, not a read of
 * `package.json`, because core is bundled for the browser too and cannot reach
 * for `node:module` at runtime. Every other package imports it rather than
 * inlining it — core is `external` to their tsup builds — so core's `dist` is
 * the single place the product version lives. Without this hook the release
 * workflow's `pnpm build` runs BEFORE semantic-release writes any version, and
 * every published package reports `0.0.0` forever: `gezel --version`,
 * `/api/health` (which the UI renders as "development build"), the system
 * diagnostics, the OpenAPI document, and the engine-download User-Agent.
 *
 * Only `packages/core` does anything here. semantic-release runs this with cwd
 * set to the package directory, once per package, so everything else is a
 * deliberate no-op rather than a second version surface to keep in sync.
 *
 * The stamped source is NOT committed — `.releaserc.json`'s git assets are
 * `CHANGELOG.md` and `package.json` only. That matches
 * `scripts/stamp-version.mjs`, which stamps the Electron scheme the same way:
 * the checkout stays at `0.0.0` and every release re-stamps from scratch.
 *
 * Env:
 *   GEZEL_RELEASE_DRY_RUN=1  print what would happen instead of doing it.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const version = process.argv[2];
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageDir = process.cwd();

if (basename(packageDir) !== 'core') process.exit(0);

if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[\w.]+)?$/.test(version ?? '')) {
  console.error(`prepare-package: expected a version argument, got ${JSON.stringify(version)}`);
  process.exit(1);
}

const sourcePath = resolve(repoRoot, 'packages/core/src/index.ts');
const source = readFileSync(sourcePath, 'utf8');
const pattern = /export const GEZEL_VERSION = '[^']*';/;

if (!pattern.test(source)) {
  console.error(`prepare-package: could not find GEZEL_VERSION declaration in ${sourcePath}`);
  process.exit(1);
}

if (process.env.GEZEL_RELEASE_DRY_RUN === '1') {
  console.log(
    `prepare-package: [dry run] would stamp GEZEL_VERSION = '${version}' and rebuild core`,
  );
  process.exit(0);
}

writeFileSync(sourcePath, source.replace(pattern, `export const GEZEL_VERSION = '${version}';`));
console.log(`prepare-package: stamped GEZEL_VERSION = '${version}'`);

// Rebuild so the tarball packed by publish-package.mjs carries the stamp. The
// workflow's earlier `pnpm build` predates the version being known.
const result = spawnSync('pnpm', ['--filter', '@bendyline/gezel', 'run', 'build'], {
  cwd: repoRoot,
  stdio: 'inherit',
});

if (result.error) {
  console.error(`prepare-package: failed to spawn pnpm: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) process.exit(result.status ?? 1);

const built = readFileSync(resolve(repoRoot, 'packages/core/dist/index.js'), 'utf8');
if (!built.includes(version)) {
  console.error(
    `prepare-package: core rebuilt but dist/index.js does not carry ${version} — refusing to publish a mis-stamped core`,
  );
  process.exit(1);
}
console.log(`prepare-package: core dist carries ${version}`);
