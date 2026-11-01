export interface CoreVersionStamp {
  version: string;
  contentCompat: string;
}

export const CORE_VERSION_SOURCE: string;
export const RELEASE_VERSION_ENV: string;
export const RELEASE_CONTENT_COMPAT_ENV: string;

export function readCoreVersionStamp(source: string): {
  version: string | null;
  contentCompat: string | null;
};

export function missingCoreVersionDeclaration(source: string): string | null;

export function stampCoreVersionSource(source: string, stamp: CoreVersionStamp): string;

export function releaseStampEnv(stamp: CoreVersionStamp): Record<string, string>;

export function releaseStampFromEnv(
  env?: Record<string, string | undefined>,
): CoreVersionStamp | null;

/** Structurally an esbuild `Plugin`; esbuild is not resolvable from scripts/. */
export function releaseStampPlugin(
  stamp: CoreVersionStamp,
  sourcePath: string,
): { name: string; setup(build: unknown): void };
