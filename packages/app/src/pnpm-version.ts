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
export const PNPM_VERSION = '11.15.1';

/** sha256 of the exact ordinary `pnpm` package tarball from the npm registry. */
export const PNPM_PACKAGE_SHA256 =
  '27460629b10111604e7f98882753b53398986820c20e0a065f3a4a5e9e7db71f';

/** sha256 of `package/LICENSE` embedded in that package tarball. */
export const PNPM_LICENSE_SHA256 =
  'e0a867ff513ea7be2a0ddc339ac6a031e459a38668e077b8f0e649544062f9f2';
