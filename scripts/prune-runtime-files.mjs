/**
 * Remove build-time-only files from a deployed runtime tree.
 *
 * `pnpm deploy` faithfully copies everything published by every production
 * dependency. That is the right default for correctness, but it also means a
 * packaged service carries thousands of source maps and TypeScript declaration
 * files that Node never opens. On Windows, every one of those files is an
 * individual tar extraction + Defender scan on first launch.
 *
 * The two declaration exceptions below are real runtime assets: the service's
 * `/api/scripts/sdk-types` route reads them from disk and sends them to Monaco
 * so the in-app script editor has IntelliSense. Keep that allowlist narrow and
 * covered by tests rather than treating every first-party declaration as
 * runtime data.
 */

import { readdir, rm, rmdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

const SOURCE_MAP_SUFFIXES = [
  '.js.map',
  '.mjs.map',
  '.cjs.map',
  '.jsx.map',
  '.ts.map',
  '.mts.map',
  '.cts.map',
  '.tsx.map',
  '.css.map',
  '.wasm.map',
];

const DECLARATION_SUFFIXES = ['.d.ts', '.d.mts', '.d.cts'];

function slash(path) {
  return path.replace(/\\/g, '/');
}

/**
 * Declaration files the running product reads as content, not as Node types.
 */
export function isRuntimeDeclaration(relativePath) {
  const path = slash(relativePath);
  return (
    /(?:^|\/)node_modules\/@bendyline\/gezel-sdk\/dist\/[^/]+\.d\.ts$/.test(path) ||
    /(?:^|\/)node_modules\/@bendyline\/gezel\/dist\/checks\/index\.d\.ts$/.test(path)
  );
}

/** Return `source-map`, `type-declaration`, or null for a deployed file. */
export function runtimePruneReason(relativePath) {
  const path = slash(relativePath).toLowerCase();
  if (SOURCE_MAP_SUFFIXES.some((suffix) => path.endsWith(suffix))) return 'source-map';
  if (
    DECLARATION_SUFFIXES.some((suffix) => path.endsWith(suffix)) &&
    !isRuntimeDeclaration(relativePath)
  ) {
    return 'type-declaration';
  }
  return null;
}

/**
 * Prune disposable files under `root` and remove directories made empty by
 * the pass. Symlinks are never followed or removed here; bundle builders own
 * their symlink policy separately.
 */
export async function pruneRuntimeFiles(root, options = {}) {
  const dryRun = options.dryRun ?? false;
  const removed = [];
  const byReason = { 'source-map': 0, 'type-declaration': 0 };
  let bytes = 0;
  let emptyDirectories = 0;

  async function walk(dir, isRoot = false) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    let survivors = 0;
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        survivors += 1;
        continue;
      }
      if (entry.isDirectory()) {
        const empty = await walk(full);
        if (empty) {
          emptyDirectories += 1;
          if (!dryRun) await rmdir(full);
        } else {
          survivors += 1;
        }
        continue;
      }
      if (!entry.isFile()) {
        survivors += 1;
        continue;
      }
      const rel = relative(root, full);
      const reason = runtimePruneReason(rel);
      if (!reason) {
        survivors += 1;
        continue;
      }
      const size = await stat(full).then(
        (value) => value.size,
        () => 0,
      );
      removed.push({ path: full, reason, size });
      byReason[reason] += 1;
      bytes += size;
      if (!dryRun) await rm(full, { force: true });
    }
    return !isRoot && survivors === 0;
  }

  await walk(root, true);
  return { removed, byReason, bytes, emptyDirectories };
}

/** Prune and emit a stable one-line build report. */
export async function pruneRuntimeFilesWithReport(root, options = {}) {
  const result = await pruneRuntimeFiles(root, options);
  console.log(
    `[prune-runtime] removed ${result.removed.length} files ` +
      `(${result.byReason['source-map']} source maps, ` +
      `${result.byReason['type-declaration']} declarations; ` +
      `${(result.bytes / 1048576).toFixed(1)} MB) and ` +
      `${result.emptyDirectories} empty directories`,
  );
  return result;
}

/**
 * Assert that the declaration allowlist still covers the files consumed by
 * `/api/sdk/types`. This runs against the real deployed graph after pruning,
 * so a future SDK output-layout change fails the release build loudly.
 */
export async function verifyRuntimeDeclarationAssets(root) {
  const sdkDist = join(root, 'node_modules', '@bendyline', 'gezel-sdk', 'dist');
  const sdkEntries = await readdir(sdkDist, { withFileTypes: true }).catch(() => []);
  const sdkDeclarations = sdkEntries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.d.ts'))
    .map((entry) => join(sdkDist, entry.name));
  const checksDeclaration = join(
    root,
    'node_modules',
    '@bendyline',
    'gezel',
    'dist',
    'checks',
    'index.d.ts',
  );
  const checksSize = await stat(checksDeclaration).then(
    (value) => value.size,
    () => 0,
  );
  if (sdkDeclarations.length === 0 || checksSize === 0) {
    throw new Error(
      '[prune-runtime] runtime declaration assets are missing; the script editor would lose Gezel SDK IntelliSense',
    );
  }
  return {
    sdkDeclarations: sdkDeclarations.length,
    checksDeclaration,
    total: sdkDeclarations.length + 1,
  };
}
