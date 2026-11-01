/**
 * The release constants in `packages/core/src/browser.ts` (`GEZEL_VERSION`,
 * `GEZEL_CONTENT_COMPAT`) and the one place that knows their source shape.
 *
 * A checkout keeps both at '0.0.0'. The npm release never rewrites the file:
 * prepare-package.mjs hands the stamp to core's build through
 * `GEZEL_RELEASE_VERSION` / `GEZEL_RELEASE_CONTENT_COMPAT`, and
 * {@link releaseStampPlugin} swaps it in as esbuild loads the file. It used to
 * rewrite the source and restore it afterwards, and the rehearsal inside
 * `pnpm all` held the file stamped for minutes: a commit made in that window
 * shipped `GEZEL_VERSION = '1.2.11'` to the branch. stamp-version.mjs still
 * rewrites the source, but only in a CI release checkout that is thrown away.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const CORE_VERSION_SOURCE = 'packages/core/src/browser.ts';
export const RELEASE_VERSION_ENV = 'GEZEL_RELEASE_VERSION';
export const RELEASE_CONTENT_COMPAT_ENV = 'GEZEL_RELEASE_CONTENT_COMPAT';

const CONSTANTS = [
  ['GEZEL_VERSION', 'version'],
  ['GEZEL_CONTENT_COMPAT', 'contentCompat'],
];

function declarationPattern(name) {
  return new RegExp(`export const ${name}(: string)? = '([^']*)';`);
}

/** Both constants as declared in `source`; a missing declaration reads as null. */
export function readCoreVersionStamp(source) {
  return Object.fromEntries(
    CONSTANTS.map(([name, key]) => [key, declarationPattern(name).exec(source)?.[2] ?? null]),
  );
}

/** The first constant `source` does not declare in the expected shape, or null. */
export function missingCoreVersionDeclaration(source) {
  return CONSTANTS.find(([name]) => !declarationPattern(name).test(source))?.[0] ?? null;
}

/** `source` with both constants set to the stamp. Throws when either is missing. */
export function stampCoreVersionSource(source, stamp) {
  const missing = missingCoreVersionDeclaration(source);
  if (missing) throw new Error(`could not find ${missing} declaration`);
  return CONSTANTS.reduce(
    (text, [name, key]) =>
      text.replace(
        declarationPattern(name),
        (_match, annotation = '') => `export const ${name}${annotation} = '${stamp[key]}';`,
      ),
    source,
  );
}

/** The environment that makes core's build carry `stamp`. */
export function releaseStampEnv(stamp) {
  return {
    [RELEASE_VERSION_ENV]: stamp.version,
    [RELEASE_CONTENT_COMPAT_ENV]: stamp.contentCompat,
  };
}

/** The stamp core's build was asked for, or null for a development build. */
export function releaseStampFromEnv(env = process.env) {
  const version = env[RELEASE_VERSION_ENV] || null;
  const contentCompat = env[RELEASE_CONTENT_COMPAT_ENV] || null;
  if (!version && !contentCompat) return null;
  // Half a stamp ships a release whose content floors read it as a dev build.
  if (!version || !contentCompat) {
    throw new Error(
      `set both ${RELEASE_VERSION_ENV} and ${RELEASE_CONTENT_COMPAT_ENV}, or neither`,
    );
  }
  return { version, contentCompat };
}

/** An esbuild plugin that stamps `sourcePath` as it is loaded, leaving the file alone. */
export function releaseStampPlugin(stamp, sourcePath) {
  const target = comparablePath(sourcePath);
  return {
    name: 'gezel-release-stamp',
    setup(build) {
      build.onLoad({ filter: /[\\/]browser\.ts$/ }, async (args) => {
        if (comparablePath(args.path) !== target) return undefined;
        const source = await readFile(args.path, 'utf8');
        return { contents: stampCoreVersionSource(source, stamp), loader: 'ts' };
      });
    },
  };
}

function comparablePath(path) {
  const absolute = resolve(path);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}
