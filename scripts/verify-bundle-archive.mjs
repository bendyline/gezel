/**
 * End-to-end verification for a generated service-bundle tarball.
 *
 * The loose deployment tree can be healthy while the archive or its extraction
 * is incomplete. That is exactly the boundary the packaged application uses,
 * so compare the extracted archive with the loose source before an installer is
 * allowed to ship. Each regular file's SHA-256 is part of the tree inventory,
 * so equal-size substitutions are caught too. The archive's own SHA-256 then
 * protects those verified bytes afterward.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, readdir, readlink, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import * as tar from 'tar';

function slash(path) {
  return path.replace(/\\/g, '/');
}

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function mapWithConcurrency(items, concurrency, visit) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await visit(items[index]);
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

/** Inventory regular files and symlinks without following symlinked directories. */
export async function inventoryBundleTree(root) {
  const entries = [];
  const files = [];

  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const path = slash(relative(root, full));
      if (entry.isSymbolicLink()) {
        entries.push({ path, kind: 'symlink', target: slash(await readlink(full)) });
      } else if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        files.push({ path, full });
      } else {
        throw new Error(`[bundle-archive] unsupported filesystem entry: ${path}`);
      }
    }
  }

  await walk(root);
  entries.push(
    ...(await mapWithConcurrency(files, 32, async ({ path, full }) => {
      const [fileStat, digest] = await Promise.all([stat(full), sha256(full)]);
      return { path, kind: 'file', size: fileStat.size, sha256: digest };
    })),
  );
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return entries;
}

/**
 * Create the archive with the same maintained Node implementation used to
 * inspect and extract it. Windows' bundled bsdtar has returned success while
 * silently omitting individual files from large service trees, so it is not a
 * safe release-artifact creator.
 *
 * node-tar's async Pack deadlocks on trees containing hardlinked files. In
 * file mode that leaves its promise unsettled, drains Node's event loop, and
 * exits 0 with a truncated archive. pnpm deployment trees use hardlinks on
 * Windows and Linux, so archive synchronously until the upstream async Pack
 * invariant is fixed: https://github.com/isaacs/node-tar/issues/460
 *
 * Do not let node-tar encode hardlinks, even in synchronous mode. It keys its
 * hardlink cache by the numeric `dev` and `ino` values returned by `fs.stat`.
 * NTFS file IDs can exceed Number.MAX_SAFE_INTEGER, making distinct files
 * collide after rounding and causing one archive entry to link to unrelated
 * content. The service runtime does not rely on hardlink identity, so storing
 * each pathname as a full file is the portable and deterministic contract.
 */
export function createBundleArchive({ sourceDir, archivePath }) {
  const disabledHardlinkCache = new (class extends Map {
    get() {
      return undefined;
    }

    set() {
      return this;
    }
  })();

  tar.create(
    {
      cwd: sourceDir,
      file: archivePath,
      gzip: true,
      linkCache: disabledHardlinkCache,
      strict: true,
      sync: true,
    },
    ['.'],
  );
}

/** Inventory filesystem entries encoded in an archive, excluding directories. */
export async function inventoryBundleArchiveEntries(archivePath) {
  const entries = [];
  await tar.list({
    file: archivePath,
    strict: true,
    onReadEntry(entry) {
      if (entry.type === 'Directory') return;
      const path = slash(entry.path).replace(/^\.\//, '').replace(/\/$/, '');
      if (path) {
        entries.push({
          path,
          type: entry.type,
          ...(entry.linkpath ? { linkpath: slash(entry.linkpath) } : {}),
        });
      }
    },
  });
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return entries;
}

/** List filesystem-entry paths encoded in an archive, excluding directories. */
export async function inventoryBundleArchivePaths(archivePath) {
  return (await inventoryBundleArchiveEntries(archivePath)).map((entry) => entry.path);
}

function describePathDifferences(source, archivedPaths) {
  const sourcePaths = new Set(source.map((entry) => entry.path));
  const archivePaths = new Set(archivedPaths);
  const missing = source.filter((entry) => !archivePaths.has(entry.path));
  const unexpected = archivedPaths
    .filter((path) => !sourcePaths.has(path))
    .map((path) => ({ path }));
  return describeDifferenceGroups({ missing, unexpected, changed: [] });
}

function describeDifferences(source, extracted) {
  const sourceByPath = new Map(source.map((entry) => [entry.path, entry]));
  const extractedByPath = new Map(extracted.map((entry) => [entry.path, entry]));
  const missing = source.filter((entry) => !extractedByPath.has(entry.path));
  const unexpected = extracted.filter((entry) => !sourceByPath.has(entry.path));
  const changed = source.filter((entry) => {
    const other = extractedByPath.get(entry.path);
    return other && JSON.stringify(entry) !== JSON.stringify(other);
  });
  return describeDifferenceGroups({ missing, unexpected, changed });
}

function describeDifferenceGroups({ missing, unexpected, changed }) {
  const sample = (entries) =>
    entries
      .slice(0, 8)
      .map((entry) => entry.path)
      .join(', ');
  return [
    missing.length > 0 ? `missing ${missing.length}: ${sample(missing)}` : null,
    unexpected.length > 0 ? `unexpected ${unexpected.length}: ${sample(unexpected)}` : null,
    changed.length > 0 ? `changed ${changed.length}: ${sample(changed)}` : null,
  ]
    .filter(Boolean)
    .join('; ');
}

/**
 * Extract `archivePath`, prove it mirrors `sourceDir`, then run an optional
 * runtime validator against the extracted tree before deleting the scratch dir.
 */
export async function verifyBundleArchiveRoundTrip({
  sourceDir,
  archivePath,
  expectedFileCount,
  validateExtracted,
}) {
  const extractedDir = await mkdtemp(join(tmpdir(), 'gezel-bundle-verify-'));
  try {
    const [source, archivedEntries] = await Promise.all([
      inventoryBundleTree(sourceDir),
      inventoryBundleArchiveEntries(archivePath),
    ]);
    const archivedPaths = archivedEntries.map((entry) => entry.path);
    if (source.length !== expectedFileCount) {
      throw new Error(
        `[bundle-archive] source file count ${source.length} does not match metadata ${expectedFileCount}`,
      );
    }
    const hardlinks = archivedEntries.filter((entry) => entry.type === 'Link');
    if (hardlinks.length > 0) {
      const sample = hardlinks
        .slice(0, 8)
        .map((entry) => `${entry.path} -> ${entry.linkpath ?? '(unknown)'}`)
        .join(', ');
      throw new Error(
        `[bundle-archive] archive contains ${hardlinks.length} hardlink entries; every bundled pathname must carry independent file content: ${sample}`,
      );
    }
    const archiveDifferences = describePathDifferences(source, archivedPaths);
    if (archiveDifferences) {
      throw new Error(
        `[bundle-archive] archive inventory differs from source (source=${source.length} archive=${archivedPaths.length}); ${archiveDifferences}`,
      );
    }

    await tar.extract({
      file: archivePath,
      cwd: extractedDir,
      strict: true,
      preservePaths: false,
    });
    const extracted = await inventoryBundleTree(extractedDir);
    const differences = describeDifferences(source, extracted);
    if (differences) {
      throw new Error(
        `[bundle-archive] extracted tree differs from source (source=${source.length} extracted=${extracted.length}); ${differences}`,
      );
    }

    if (validateExtracted) await validateExtracted(extractedDir);
    return { fileCount: extracted.length };
  } finally {
    await rm(extractedDir, { recursive: true, force: true });
  }
}
