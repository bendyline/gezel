/**
 * Types for `published-packages.mjs`, hand-written because that module is
 * plain Node the release scripts run before any build. See its header for why
 * the registry lives there rather than in TypeScript.
 */

export interface PublishedPackageEntry {
  /** Directory name under `packages/`. */
  dir: string;
  /** Whether the package emits `.d.ts` declarations. */
  typed: boolean;
}

export declare const PUBLISHED_PACKAGES: ReadonlyArray<PublishedPackageEntry>;
export declare const PUBLISHED_PACKAGE_DIRS: readonly string[];
export declare const VERSIONED_NOT_PUBLISHED: readonly string[];
export declare const RELEASE_IGNORED_PACKAGE_PATHS: readonly string[];
export declare function readPublishedManifest(
  repoRoot: string,
  dir: string,
): Record<string, unknown> & { name: string; version: string };
export declare function publishedPackageNames(repoRoot: string): string[];
