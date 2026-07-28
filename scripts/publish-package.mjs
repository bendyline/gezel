#!/usr/bin/env node
/**
 * Publish one workspace package to npm, invoked by `@semantic-release/exec`
 * once multi-semantic-release has stamped the package's next version.
 *
 * WHY THIS EXISTS INSTEAD OF `@semantic-release/npm`'s own publish step:
 * that plugin shells out to `npm publish`, and npm does not understand
 * pnpm's `workspace:*` protocol. Publishing through npm would ship manifests
 * containing a literal `"@bendyline/gezel": "workspace:*"`, which no consumer
 * can install. `pnpm publish` rewrites `workspace:*` to the sibling's
 * concrete version at pack time, which is exactly the behaviour we want and
 * is why every cross-package dependency in this repo can stay on the
 * workspace protocol. See docs/npm-release.md.
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
import { resolve } from 'node:path';

const packageDir = process.cwd();
const manifestPath = resolve(packageDir, 'package.json');

let pkg;
try {
  pkg = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch (err) {
  console.error(`publish-package: cannot read ${manifestPath}: ${err.message}`);
  process.exit(1);
}

// `packages/app` and `packages/vscode` are versioned, tagged and changelogged
// by multi-semantic-release but ship through electron-builder and the VS Code
// Marketplace instead. Their `private: true` is the switch that keeps them off
// npm, so honour it here rather than maintaining a second exclusion list.
if (pkg.private) {
  console.log(`publish-package: ${pkg.name} is private — skipping npm publish`);
  process.exit(0);
}

const args = ['publish', '--no-git-checks', '--access', 'public', '--provenance'];

if (process.env.GEZEL_RELEASE_DRY_RUN === '1') {
  console.log(`publish-package: [dry run] ${pkg.name}@${pkg.version}: pnpm ${args.join(' ')}`);
  process.exit(0);
}

console.log(`publish-package: publishing ${pkg.name}@${pkg.version}`);
const result = spawnSync('pnpm', args, { cwd: packageDir, stdio: 'inherit' });

if (result.error) {
  console.error(`publish-package: failed to spawn pnpm: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
