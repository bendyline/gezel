/**
 * The npm cache the packed-consumer check installs through.
 *
 * It is a folder of its own, never the developer's global cache: the check must
 * not depend on or change that cache, and a stale root-owned entry there once
 * turned `pnpm all` into an EPERM. It is kept between runs. Emptied with each
 * run, it made every rehearsal download the whole graph again, and npm 11
 * resolves with full packuments: 693 of them, 249 MB of metadata, before the
 * first dependency tarball (2026-11-13). A kept cache only revalidates them.
 */
import { existsSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { join, posix, resolve, win32 } from 'node:path';

/** Past this size the cache is started over: superseded packuments and old tarballs pile up. */
export const NPM_CONSUMER_CACHE_MAX_BYTES = 3 * 1024 * 1024 * 1024;

const FILE_TARBALL_KEY = 'pacote:tarball:file:';

export function npmConsumerCacheDir(repoRoot, env = process.env) {
  return resolve(env.GEZEL_CONSUMER_NPM_CACHE || join(repoRoot, '.cache', 'npm-consumer-cache'));
}

function treeBytes(root) {
  let total = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    total += entry.isDirectory() ? treeBytes(path) : lstatSync(path).size;
  }
  return total;
}

/** Report what the cache holds, and start it over once it outgrows `maxBytes`. */
export function prepareNpmConsumerCache(
  dir,
  { maxBytes = NPM_CONSUMER_CACHE_MAX_BYTES, log = console.log } = {},
) {
  if (!existsSync(dir)) {
    log(`  note npm cache ${dir} is empty, so this install downloads the whole graph`);
    return { bytes: 0, reset: false };
  }
  const bytes = treeBytes(dir);
  const mib = (bytes / 1024 / 1024).toFixed(0);
  if (bytes > maxBytes) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    log(`  note npm cache ${dir} had grown to ${mib} MiB; started it over`);
    return { bytes, reset: true };
  }
  log(`  note npm cache ${dir} holds ${mib} MiB from earlier runs`);
  return { bytes, reset: false };
}

/**
 * The cache keys holding this run's candidate tarballs, one per tarball.
 *
 * npm stores every `file:` tarball it installs, under keys naming the path it
 * was given: relative to the consumer project, absolute, or both. A key names a
 * run's own temporary folder, so nothing reads it again. Only one key per
 * tarball is returned because `npm cache clean` deletes the content a key points
 * at and stops at the first key whose content is already gone.
 */
export function candidateTarballCacheKeys(
  listing,
  tarballs,
  consumerDir,
  platform = process.platform,
) {
  const paths = platform === 'win32' ? win32 : posix;
  const comparable = (...segments) => {
    const path = paths.resolve(...segments);
    return platform === 'win32' ? path.toLowerCase() : path;
  };
  const wanted = new Set(tarballs.map((tarball) => comparable(tarball)));
  const keys = new Map();
  for (const line of listing.split(/\r?\n/)) {
    const key = line.trim();
    if (!key.startsWith(FILE_TARBALL_KEY)) continue;
    const path = comparable(consumerDir, key.slice(FILE_TARBALL_KEY.length));
    if (wanted.has(path) && !keys.has(path)) keys.set(path, key);
  }
  return [...keys.values()];
}

/**
 * Remove this run's candidate tarballs from the kept cache, or the release set
 * (about 125 MB) would be added to it on every run. Never throws: a cache that
 * keeps a few tarballs too many must not fail a run whose checks passed.
 */
export function pruneCandidateTarballs({ runNpm, tarballs, consumerDir, log = console.log }) {
  if (tarballs.length === 0) return 0;
  try {
    const listed = runNpm(['cache', 'ls']);
    if (listed.status !== 0) {
      throw new Error(listed.stderr?.trim() || `npm cache ls exited ${listed.status}`);
    }
    const keys = candidateTarballCacheKeys(listed.stdout, tarballs, consumerDir);
    if (keys.length === 0) return 0;
    const cleaned = runNpm(['cache', 'clean', ...keys]);
    if (cleaned.status !== 0) {
      throw new Error(cleaned.stderr?.trim() || `npm cache clean exited ${cleaned.status}`);
    }
    log(`  note removed this run's ${keys.length} candidate tarballs from the npm cache`);
    return keys.length;
  } catch (error) {
    log(`  note could not remove this run's tarballs from the npm cache: ${error.message}`);
    return 0;
  }
}
