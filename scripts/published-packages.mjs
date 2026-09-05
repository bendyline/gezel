/**
 * The one registry of packages gezel publishes to npm.
 *
 * WHY THIS FILE EXISTS: this list used to be written out three times — in
 * `check-package-consumers.mjs`, in `rehearse-npm-release.mjs`, and in
 * `tests/published/_packages.ts`, the first of which carried a comment asking
 * the next person to keep them in step. They drifted anyway. The rehearsal
 * never learned about `gezk`, so `pnpm check:npm-release-candidate` — the
 * command docs/npm-release.md points at as the final pre-release gate —
 * packed twelve tarballs and the consumer check it hands them to rejected the
 * set outright. The loud failure was the lesser problem: a rehearsal that got
 * past the count would have installed twelve local tarballs and let npm
 * resolve `@bendyline/gezk` from the public registry, validating the
 * already-published package instead of the candidate build.
 *
 * It is `.mjs` rather than `.ts` because the two release scripts are plain
 * Node and run before, and without, any build. `tests/published/_packages.ts`
 * imports it through the hand-written `published-packages.d.mts` beside it.
 *
 * Adding or removing a published package means editing THIS FILE and nothing
 * else. `packageShape.test.ts` fails when a directory under `packages/` is
 * neither published, versioned-but-private, nor explicitly ignored, so a new
 * package cannot quietly go missing from the release the way `gezk` did.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Every package published to npm, in build order.
 *
 * `typed` records whether the package emits `.d.ts` declarations; the three
 * that do not are deliberate and each says why.
 */
export const PUBLISHED_PACKAGES = [
  { dir: 'gezk', typed: true },
  { dir: 'core', typed: true },
  { dir: 'client', typed: true },
  { dir: 'sdk', typed: true },
  { dir: 'app-sdk', typed: true },
  { dir: 'plugin-sdk', typed: true },
  { dir: 'catalog', typed: true },
  { dir: 'knowledge', typed: true },
  { dir: 'mcp', typed: true },
  { dir: 'service', typed: true },
  // Spawn-only: the service resolves `run-action` and executes it as a
  // subprocess, never imports it, so it emits no declarations.
  { dir: 'connectors-spectral', typed: false },
  // Ships plain `.ts` gate-script sources read in place by the runner.
  { dir: 'script-stdlib', typed: false },
  // Bin-only: its public contract is the `gezel` command line.
  { dir: 'cli', typed: false },
];

/** Directory names under `packages/`, in the same order. */
export const PUBLISHED_PACKAGE_DIRS = PUBLISHED_PACKAGES.map(({ dir }) => dir);

/**
 * Packages multi-semantic-release versions, tags and changelogs but never
 * publishes — they stay `private` and ship through electron-builder and the
 * VS Code Marketplace.
 */
export const VERSIONED_NOT_PUBLISHED = ['app', 'vscode'];

/**
 * Workspace directories multi-semantic-release skips entirely, mirroring
 * `--ignore-packages` in `.github/workflows/publish-npm.yml`. Kept here so
 * the completeness check in `packageShape.test.ts` has a closed set to test
 * against; that test also asserts this matches the workflow.
 */
export const RELEASE_IGNORED_PACKAGE_PATHS = [
  'packages/ui',
  'packages/eval-viewer',
  'packages/sharp-compat',
  'packages/ml-runtime',
  'evals',
];

/** Read one published package's manifest from a repo checkout. */
export function readPublishedManifest(repoRoot, dir) {
  return JSON.parse(readFileSync(resolve(repoRoot, 'packages', dir, 'package.json'), 'utf8'));
}

/** npm names of every published package, e.g. `@bendyline/gezel-cli`. */
export function publishedPackageNames(repoRoot) {
  return PUBLISHED_PACKAGE_DIRS.map((dir) => readPublishedManifest(repoRoot, dir).name);
}
