/**
 * Optional peers that must not join the production dependency graph.
 *
 * pnpm satisfies an optional peer with any package of that name the workspace
 * holds, and a satisfied peer becomes a dependency of the package that named
 * it. Spectral 10.39 names vitest and @jest/globals as optional peers for its
 * `/testing` helpers, which Gezel never imports. With vitest in the workspace
 * as a dev dependency, the lockfile made the test runner, Vite and MPL-2.0
 * lightningcss production dependencies of the connector runner, and so of
 * every installer that ships it (the license gate caught it, 2026-11-18).
 *
 * A hook is the only way to drop one. An `overrides` entry of "-" removes the
 * peer's range but leaves its `peerDependenciesMeta` entry, which pnpm reads
 * as the same optional peer at "*"; `packageExtensions` can only add; and a
 * range nothing satisfies is still linked, with a warning.
 */
const UNUSED_OPTIONAL_PEERS = {
  '@prismatic-io/spectral': ['vitest', '@jest/globals'],
};

function readPackage(pkg) {
  for (const peer of UNUSED_OPTIONAL_PEERS[pkg.name] ?? []) {
    if (pkg.peerDependencies) delete pkg.peerDependencies[peer];
    if (pkg.peerDependenciesMeta) delete pkg.peerDependenciesMeta[peer];
  }
  return pkg;
}

module.exports = { hooks: { readPackage } };
