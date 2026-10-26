import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/**
 * Gilde is an optional peer, so it is found only where npm put it beside
 * this package. A service that pins it resolves it itself and passes the
 * folder in (`BundledSourceOptions.dataDir`, `CatalogService`'s
 * `contentRoot`); this message is for everyone else.
 */
export const GILDE_NOT_FOUND_MESSAGE =
  '@bendyline/gezel-catalog cannot find its content package, @bendyline/gilde. ' +
  'Install it beside the catalog with `npm install @bendyline/gilde` ' +
  '(add -g if the catalog is installed globally), or set GEZEL_GILDE_DATA_DIR ' +
  "to the folder that holds Gilde's data.";

/**
 * Root of the installed (or link:ed) @bendyline/gilde package — the
 * external content repo that replaced the old in-package `data/` tree.
 *
 * Resolved via the package's `./package.json` export; if gilde ever
 * ships an `exports` map without that subpath, this throws and the
 * service boots with an empty catalog (see the AGENTS.md gotcha and
 * the guard test in gilde-data.test.ts).
 */
export function gildePackageRoot(): string {
  const require = createRequire(import.meta.url);
  try {
    return dirname(require.resolve('@bendyline/gilde/package.json'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== 'MODULE_NOT_FOUND') throw error;
    throw new Error(GILDE_NOT_FOUND_MESSAGE, { cause: error });
  }
}

/**
 * The catalog content root (kind dirs + community/). Honors
 * GEZEL_GILDE_DATA_DIR (absolute path to a data dir, e.g. a raw
 * ../gilde/data checkout) so tests, evals, and operators can bypass
 * node resolution entirely. Not cached — the override must stay
 * flippable within a process (tests rely on it).
 */
export function gildeDataDir(): string {
  const override = process.env.GEZEL_GILDE_DATA_DIR?.trim();
  if (override) return override;
  return join(gildePackageRoot(), 'data');
}
