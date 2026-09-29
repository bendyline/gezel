/**
 * Pinned pnpm release that ships with this Gezel version.
 *
 * Gezel bundles pnpm's ordinary, platform-neutral npm package and launches
 * its JavaScript entrypoint with Gezel's separately bundled Node runtime.
 * This keeps system-toolset installs working without a global Node/pnpm
 * install and avoids redistributing pnpm's standalone executable.
 *
 * Bumping: run `node scripts/bump-pnpm.mjs <version>` — it fetches the
 * package, computes sha256s, and rewrites this file. The PR diff is the
 * audit trail. Never hand-edit a sha.
 */
export const PNPM_VERSION = '11.27.1';

/** sha256 of the exact ordinary `pnpm` package tarball from the npm registry. */
export const PNPM_PACKAGE_SHA256 =
  'd50f8841e67ef0b1d82e7c90b240656c7ca04d5f1aa33f06108007c81fd76766';

/** sha256 of `package/LICENSE` embedded in that package tarball. */
export const PNPM_LICENSE_SHA256 =
  'e0a867ff513ea7be2a0ddc339ac6a031e459a38668e077b8f0e649544062f9f2';
