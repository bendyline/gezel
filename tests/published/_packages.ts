/**
 * Test-side view of the published-package registry, driving every loop in the
 * `tests/published/` suite. The registry itself is
 * `scripts/published-packages.mjs` — plain Node, because the release scripts
 * that share it run before any build. Adding a published package means
 * editing that file and nothing else.
 *
 * These tests run against built `dist/` output, not `src/` — they catch
 * publishing-shape bugs the in-package vitest suites cannot see (missing
 * `exports` targets, `workspace:*` leaking into a tarball, source maps
 * bloating the payload, a subpath the service `require.resolve`s at
 * runtime disappearing from the `exports` map).
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUBLISHED_PACKAGES } from '../../scripts/published-packages.mjs';

/** Repo root (parent of `tests/published/`). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface PackageJson {
  name: string;
  version: string;
  private?: boolean;
  type?: string;
  main?: string;
  module?: string;
  types?: string;
  bin?: Record<string, string>;
  files?: string[];
  exports?: Record<string, ExportValue>;
  publishConfig?: { access?: string; provenance?: boolean };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  optionalDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

export type ExportValue =
  | string
  | { types?: string; import?: string; require?: string; default?: string };

export interface PublicPackage {
  /** npm name, e.g. `@bendyline/gezel-cli`. */
  name: string;
  /** Directory name under `packages/`. */
  dir: string;
  /** Absolute path to the package directory. */
  path: string;
  /** Absolute path to the package's `dist/` directory. */
  dist: string;
  /** Whether the package emits `.d.ts` declarations. */
  typed: boolean;
  pkg: PackageJson;
}

export {
  PUBLISHED_PACKAGES,
  RELEASE_IGNORED_PACKAGE_PATHS,
  VERSIONED_NOT_PUBLISHED,
} from '../../scripts/published-packages.mjs';

export function readManifest(dir: string): PackageJson {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, 'packages', dir, 'package.json'), 'utf8'));
}

/** Resolved list of published packages, read fresh from disk. */
export function loadPublishedPackages(): PublicPackage[] {
  return PUBLISHED_PACKAGES.map(({ dir, typed }) => {
    const path = resolve(REPO_ROOT, 'packages', dir);
    const pkg = readManifest(dir);
    return { name: pkg.name, dir, path, dist: resolve(path, 'dist'), typed, pkg };
  });
}

/** Flatten an `exports` map into `[subpath, condition, target]` triples. */
export function exportTargets(pkg: PackageJson): Array<{
  subpath: string;
  condition: string;
  target: string;
}> {
  const out: Array<{ subpath: string; condition: string; target: string }> = [];
  for (const [subpath, value] of Object.entries(pkg.exports ?? {})) {
    if (typeof value === 'string') {
      out.push({ subpath, condition: 'default', target: value });
      continue;
    }
    for (const [condition, target] of Object.entries(value)) {
      if (typeof target === 'string') out.push({ subpath, condition, target });
    }
  }
  return out;
}
