import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

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
  return dirname(require.resolve('@bendyline/gilde/package.json'));
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
