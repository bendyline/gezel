import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/**
 * The `@bendyline/gilde` release this service pins, resolved from the
 * service's own location.
 *
 * The catalog's `gildeDataDir()` resolves Gilde from the *catalog's* folder,
 * where Gilde is only an optional peer. That works when npm hoists Gilde next
 * to the catalog, but not when `@bendyline/gezel-catalog` is installed
 * globally beside the service: the service's Gilde then sits inside its own
 * folder, out of the catalog's reach, and the daemon failed at boot with
 * "Cannot find module '@bendyline/gilde/package.json'". The service owns the
 * exact pin, so it finds Gilde itself and hands the folder to every catalog
 * it builds.
 */
let packageRoot: string | null = null;

export function bundledGildePackageRoot(): string {
  if (packageRoot === null) {
    const require = createRequire(import.meta.url);
    packageRoot = dirname(require.resolve('@bendyline/gilde/package.json'));
  }
  return packageRoot;
}

/**
 * The bundled content root (kind dirs + community/). `GEZEL_GILDE_DATA_DIR`
 * wins, read on every call so tests and evals can flip it within a process.
 */
export function bundledGildeDataDir(): string {
  const override = process.env.GEZEL_GILDE_DATA_DIR?.trim();
  if (override) return override;
  return join(bundledGildePackageRoot(), 'data');
}
