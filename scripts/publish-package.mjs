#!/usr/bin/env node
/**
 * Publish one workspace package to npm, invoked by `@semantic-release/exec`
 * once multi-semantic-release has stamped the package's next version.
 *
 * WHY THIS EXISTS INSTEAD OF `@semantic-release/npm`'s own publish step:
 * that plugin shells out to `npm publish`, and npm does not understand
 * pnpm's `workspace:*` protocol. Publishing through npm would ship manifests
 * containing a literal `"@bendyline/gezel": "workspace:*"`, which no consumer
 * can install. `pnpm publish` rewrites unchanged `workspace:*` dependencies,
 * while the release-state bridge materializes changed dependency versions
 * computed by multi-semantic-release. This lets source manifests stay on the
 * workspace protocol without publishing stale sibling pins. See
 * docs/npm-release.md.
 *
 * Auth is npm Trusted Publishing (OIDC) — there is deliberately no
 * NPM_TOKEN/NODE_AUTH_TOKEN. pnpm performs the token exchange itself, which
 * requires the workflow to grant `id-token: write` and to have configured
 * setup-node with `registry-url: https://registry.npmjs.org`.
 *
 * semantic-release runs this with cwd set to the package directory.
 *
 * Env:
 *   GEZEL_RELEASE_DRY_RUN=1  print the command instead of running it.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  clearReleasePackageState,
  materializeReleasePackageState,
} from './release-package-state.mjs';
import { findWorkspaceDependencies, readWorkspaceManifests } from './workspace-dependencies.mjs';

const packageDir = process.cwd();
const manifestPath = resolve(packageDir, 'package.json');
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let pkg;
let sourceManifest;
try {
  sourceManifest = readFileSync(manifestPath, 'utf8');
  pkg = JSON.parse(sourceManifest);
} catch (err) {
  console.error(`publish-package: cannot read ${manifestPath}: ${err.message}`);
  process.exit(1);
}

// `packages/app` and `packages/vscode` are versioned, tagged and changelogged
// by multi-semantic-release but ship through electron-builder and the VS Code
// Marketplace instead. Their `private: true` is the switch that keeps them off
// npm, so honour it here rather than maintaining a second exclusion list.
if (pkg.private) {
  clearReleasePackageState({ repoRoot, packageName: pkg.name });
  console.log(`publish-package: ${pkg.name} is private — skipping npm publish`);
  process.exit(0);
}

const args = ['publish', '--no-git-checks', '--access', 'public', '--provenance'];

if (process.env.GEZEL_RELEASE_DRY_RUN === '1') {
  console.log(`publish-package: [dry run] ${pkg.name}@${pkg.version}: pnpm ${args.join(' ')}`);
  process.exit(0);
}

console.log(`publish-package: publishing ${pkg.name}@${pkg.version}`);
let materialized;
try {
  materialized = materializeReleasePackageState({
    repoRoot,
    packageName: pkg.name,
    packageVersion: pkg.version,
    manifestPath,
    sourceManifest,
  });
} catch (err) {
  console.error(`publish-package: cannot read preserved dependency versions: ${err.message}`);
  process.exit(1);
}

if (materialized.materialized) {
  console.log('publish-package: materialized dependency versions selected for this release');
}

let workspaceDependencies;
try {
  const workspace = readWorkspaceManifests(repoRoot);
  workspaceDependencies = findWorkspaceDependencies(pkg, workspace.names);
} catch (err) {
  materialized.restore();
  console.error(`publish-package: cannot inspect workspace dependency graph: ${err.message}`);
  process.exit(1);
}
if (workspaceDependencies.length > 0 && !materialized.materialized) {
  materialized.restore();
  console.error(
    `publish-package: refusing to publish ${pkg.name} without prepare-time release state for ${workspaceDependencies.length} local dependency edge(s)`,
  );
  process.exit(1);
}

let result;
try {
  result = spawnSync('pnpm', args, { cwd: packageDir, stdio: 'inherit' });
} finally {
  materialized.restore();
}

if (result.error) {
  console.error(`publish-package: failed to spawn pnpm: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
