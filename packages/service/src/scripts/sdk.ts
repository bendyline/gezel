import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SdkTypesResponse } from '@bendyline/gezel';

export const SDK_PACKAGE_NAME = '@bendyline/gezel-sdk';

/**
 * Keep dependencies nested inside the SDK checkout out of the script
 * sandbox, while still copying an SDK whose OWN installed path lives under
 * `node_modules`. Checking the absolute source path filtered out the package
 * root in every published npm install and left gate scripts unable to import
 * `@bendyline/gezel-sdk`.
 */
export function shouldVendorSdkPath(sdkDir: string, sourcePath: string): boolean {
  const withinSdk = relative(sdkDir, sourcePath);
  return !withinSdk.split(/[\\/]/).includes('node_modules');
}

/**
 * Locate the on-disk `@bendyline/gezel-sdk` package.
 *
 * Shared by the script runner (which vendors the whole package into the
 * sandbox scratch dir) and the sdk-types route (which serves the typings
 * to the in-app editor so IntelliSense matches the SDK that will
 * actually run).
 *
 * This module's own location varies by deployment: `src/scripts/` under
 * vitest, `dist/index.js` (single tsup bundle) when the service runs
 * inside the app, an installed tree under Application Support for the
 * system daemon. Fixed-depth relative candidates broke the moment the
 * dist layout was exercised, so instead: walk UP from here checking
 * `sdk/` and `packages/sdk/` at every level, then fall back to module
 * resolution for installed layouts (the SDK is ESM-only, so resolve via
 * `import.meta.resolve` and walk up from the entry file to the package
 * root).
 */
export async function resolveSdkDir(): Promise<string> {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth++) {
    for (const candidate of [join(dir, 'sdk'), join(dir, 'packages', 'sdk')]) {
      if (await isSdkDir(candidate)) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  let entryDir: string;
  try {
    entryDir = dirname(fileURLToPath(import.meta.resolve(SDK_PACKAGE_NAME)));
  } catch {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    entryDir = dirname(require.resolve(`${SDK_PACKAGE_NAME}/package.json`));
  }
  for (let depth = 0; depth < 4; depth++) {
    if (await isSdkDir(entryDir)) return entryDir;
    const parent = dirname(entryDir);
    if (parent === entryDir) break;
    entryDir = parent;
  }
  throw new Error(`could not locate the ${SDK_PACKAGE_NAME} package on disk`);
}

async function isSdkDir(dir: string): Promise<boolean> {
  try {
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as {
      name?: string;
    };
    return pkg.name === SDK_PACKAGE_NAME;
  } catch {
    return false;
  }
}

let cachedTypes: SdkTypesResponse | null = null;

/**
 * The typings the in-app editor needs for full script IntelliSense,
 * served as virtual `node_modules` paths (each file's `name` is its
 * path under node_modules — e.g. `@bendyline/gezel-sdk/index.d.ts`):
 *
 *  - every `.d.ts` in the SDK dist (the main surface plus the `/checks`
 *    entry and any shared dts chunks they import relatively), and
 *  - core's self-contained `@bendyline/gezel/checks` dts, which the
 *    SDK's `checks.d.ts` re-exports (`export * from '@bendyline/gezel/checks'`
 *    stays external in the dts bundle, so the editor needs the target).
 *
 * Cached for the process lifetime — the SDK on disk only changes with a
 * rebuild, which restarts the service in every supported layout.
 */
export async function readSdkTypes(): Promise<SdkTypesResponse> {
  if (cachedTypes) return cachedTypes;
  const sdkDir = await resolveSdkDir();
  const files: SdkTypesResponse['files'] = [];
  const { readdir } = await import('node:fs/promises');
  const distDir = join(sdkDir, 'dist');
  for (const entry of (await readdir(distDir)).sort()) {
    if (!entry.endsWith('.d.ts')) continue;
    files.push({
      name: `${SDK_PACKAGE_NAME}/${entry}`,
      content: await readFile(join(distDir, entry), 'utf8'),
    });
  }
  try {
    const checksEntry = fileURLToPath(import.meta.resolve('@bendyline/gezel/checks'));
    const checksDts = checksEntry.replace(/\.js$/, '.d.ts');
    files.push({
      name: '@bendyline/gezel/checks/index.d.ts',
      content: await readFile(checksDts, 'utf8'),
    });
  } catch {
    /* core build without the checks entry — SDK surface still works */
  }
  const hash = createHash('sha256');
  for (const f of files) hash.update(f.name).update('\0').update(f.content);
  cachedTypes = { version: hash.digest('hex'), files };
  return cachedTypes;
}
