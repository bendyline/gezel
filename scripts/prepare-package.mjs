#!/usr/bin/env node
/**
 * Prepare one package after multi-semantic-release has computed its next
 * version: restore local dependency declarations to `workspace:*`, then stamp
 * the product version into `packages/core/src/index.ts` when preparing core.
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
 * semantic-release runs this with cwd set to the package directory, once per
 * package. Dependency normalization is required for every package because
 * multi-semantic-release replaces workspace ranges with concrete versions
 * before calling configured prepare plugins. Only `packages/core` performs
 * the additional source stamp and rebuild.
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
import { calVerPrefix } from './calver.mjs';
import { writeReleasePackageState } from './release-package-state.mjs';
import {
  findWorkspaceDependencies,
  findWorkspaceDependencyViolations,
  normalizeWorkspaceManifest,
  readWorkspaceManifests,
} from './workspace-dependencies.mjs';

const version = process.argv[2];
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageDir = process.cwd();
const dryRun = process.env.GEZEL_RELEASE_DRY_RUN === '1';

if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[\w.]+)?$/.test(version ?? '')) {
  console.error(`prepare-package: expected a version argument, got ${JSON.stringify(version)}`);
  process.exit(1);
}

// multi-semantic-release deliberately replaces changed local workspace ranges
// with the versions it selected before calling semantic-release's prepare
// plugins. Preserve that release-only manifest before restoring the source
// invariant: publish-package.mjs materializes it while pnpm packs the tarball.
// This bridge matters because multi-semantic-release serializes each package's
// prepare+publish pair; a dependency that publishes later still has its old
// on-disk version when this package is packed.
let currentRecord;
let workspaceNames;
try {
  const workspace = readWorkspaceManifests(repoRoot);
  currentRecord = workspace.records.find(
    ({ path }) => resolve(path) === resolve(packageDir, 'package.json'),
  );
  workspaceNames = workspace.names;
} catch (err) {
  console.error(`prepare-package: could not inspect workspace manifests: ${err.message}`);
  process.exit(1);
}

if (!currentRecord) {
  console.error(`prepare-package: ${packageDir} is not a Gezel workspace package`);
  process.exit(1);
}

const dependencyChanges = findWorkspaceDependencyViolations(currentRecord.manifest, workspaceNames);
const workspaceDependencies = findWorkspaceDependencies(currentRecord.manifest, workspaceNames);
// Preserve state for every package with local edges, even when msr left those
// edges as workspace:*. publish-package.mjs deliberately fails closed without
// this hand-off, so a dropped/misordered prepare hook cannot silently fall back
// to whichever sibling versions happen to be on disk.
if (!dryRun && workspaceDependencies.length > 0) {
  writeReleasePackageState({
    repoRoot,
    packageName: currentRecord.manifest.name,
    packageVersion: currentRecord.manifest.version,
    source: currentRecord.source,
  });
}
if (dependencyChanges.length > 0) {
  const action = dryRun ? 'would restore' : 'restored';
  console.log(
    `prepare-package: ${action} ${dependencyChanges.length} workspace dependency specifier(s) in ${currentRecord.manifest.name}`,
  );
}
if (!dryRun && dependencyChanges.length > 0)
  normalizeWorkspaceManifest(currentRecord, workspaceNames);

if (basename(packageDir) !== 'core') process.exit(0);

const sourcePath = resolve(repoRoot, 'packages/core/src/index.ts');
const source = readFileSync(sourcePath, 'utf8');
const pattern = /export const GEZEL_VERSION = '[^']*';/;
const compatPattern = /export const GEZEL_CONTENT_COMPAT = '[^']*';/;

if (!pattern.test(source)) {
  console.error(`prepare-package: could not find GEZEL_VERSION declaration in ${sourcePath}`);
  process.exit(1);
}

// npm versions are semver and carry no date, but gilde's `minGezelVersion`
// floors are authored as `1.YYDDD`. Stamp today's calendar line alongside the
// published version so floors are compared on the axis they were written for;
// see GEZEL_CONTENT_COMPAT in packages/core/src/index.ts.
if (!compatPattern.test(source)) {
  console.error(
    `prepare-package: could not find GEZEL_CONTENT_COMPAT declaration in ${sourcePath}`,
  );
  process.exit(1);
}
const contentCompat = calVerPrefix();

if (dryRun) {
  console.log(
    `prepare-package: [dry run] would stamp GEZEL_VERSION = '${version}', GEZEL_CONTENT_COMPAT = '${contentCompat}' and rebuild core`,
  );
  process.exit(0);
}

writeFileSync(
  sourcePath,
  source
    .replace(pattern, `export const GEZEL_VERSION = '${version}';`)
    .replace(compatPattern, `export const GEZEL_CONTENT_COMPAT = '${contentCompat}';`),
);
console.log(
  `prepare-package: stamped GEZEL_VERSION = '${version}', GEZEL_CONTENT_COMPAT = '${contentCompat}'`,
);

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
// An unstamped compat value ships a build that every content floor treats as a
// dev build, silently disabling the gate for every consumer of this release.
if (!new RegExp(`GEZEL_CONTENT_COMPAT\\s*=\\s*"${contentCompat}"`).test(built)) {
  console.error(
    `prepare-package: core rebuilt but dist/index.js does not carry GEZEL_CONTENT_COMPAT ${contentCompat} — refusing to publish a build that cannot honour content floors`,
  );
  process.exit(1);
}
console.log(`prepare-package: core dist carries ${version} (content compat ${contentCompat})`);
