#!/usr/bin/env node
/**
 * Fail the npm release early when a registered package has never been
 * published.
 *
 * WHY: the release publishes through npm trusted publishing (OIDC), and a
 * trusted publisher can only be configured on a package that already exists.
 * A package added to published-packages.mjs without its one-time hand
 * bootstrap therefore fails inside multi-semantic-release, after the packages
 * that depend on it have gone out pinned to a version nobody can install.
 * That happened with @bendyline/gezel-knowledge (2026-08) and again with
 * @bendyline/gezel-script-runtime (2026-09). The bootstrap procedure is in
 * docs/npm-release.md ("A package added after the bootstrap").
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { publishedPackageNames } from './published-packages.mjs';

const REGISTRY = 'https://registry.npmjs.org';

/**
 * @param {{ names: string[], fetch?: typeof fetch }} input
 * @returns {Promise<{ missing: string[], unreachable: string[] }>}
 */
export async function findUnbootstrappedPackages({ names, fetch: fetchImpl = fetch }) {
  const missing = [];
  const unreachable = [];
  await Promise.all(
    names.map(async (name) => {
      const url = `${REGISTRY}/${name.replace('/', '%2f')}`;
      try {
        const response = await fetchImpl(url, {
          headers: { accept: 'application/vnd.npm.install-v1+json' },
        });
        if (response.status === 404) missing.push(name);
        else if (!response.ok) unreachable.push(`${name} (HTTP ${response.status})`);
      } catch (error) {
        unreachable.push(`${name} (${error instanceof Error ? error.message : String(error)})`);
      }
    }),
  );
  return { missing: missing.sort(), unreachable: unreachable.sort() };
}

async function main() {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const names = publishedPackageNames(repoRoot);
  const { missing, unreachable } = await findUnbootstrappedPackages({ names });
  if (unreachable.length > 0) {
    console.error(
      `npm bootstrap check could not reach the registry for:\n  ${unreachable.join('\n  ')}`,
    );
    process.exitCode = 1;
    return;
  }
  if (missing.length > 0) {
    console.error(
      [
        'These packages are registered for release but do not exist on npm yet:',
        ...missing.map((name) => `  ${name}`),
        '',
        'Trusted publishing cannot create a package. Bootstrap each one by hand first',
        '(see docs/npm-release.md, "A package added after the bootstrap"), register its',
        'trusted publisher on npmjs.com, then re-run the release.',
      ].join('\n'),
    );
    process.exitCode = 1;
    return;
  }
  console.log(`npm bootstrap check: all ${names.length} release packages exist on npm`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
