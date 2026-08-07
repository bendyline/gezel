/**
 * End-to-end verification for a generated service-bundle tarball.
 *
 * The loose deployment tree can be healthy while the archive or its extraction
 * is incomplete. That is exactly the boundary the packaged application uses,
 * so compare the extracted archive with the loose source before an installer is
 * allowed to ship. Paths and sizes are sufficient here: the archive's SHA-256
 * protects its bytes afterward, while this pass proves that every source entry
 * actually rode into those bytes and came back out through the same `tar`
 * implementation used by the supervisor.
 */

import { mkdtemp, readdir, readlink, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import * as tar from 'tar';

function slash(path) {
  return path.replace(/\\/g, '/');
}

/** Inventory regular files and symlinks without following symlinked directories. */
export async function inventoryBundleTree(root) {
  const entries = [];

  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const path = slash(relative(root, full));
      if (entry.isSymbolicLink()) {
        entries.push({ path, kind: 'symlink', target: slash(await readlink(full)) });
      } else if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        entries.push({ path, kind: 'file', size: (await stat(full)).size });
      } else {
        throw new Error(`[bundle-archive] unsupported filesystem entry: ${path}`);
      }
    }
  }

  await walk(root);
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return entries;
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
    await tar.extract({
      file: archivePath,
      cwd: extractedDir,
      strict: true,
      preservePaths: false,
    });
    const [source, extracted] = await Promise.all([
      inventoryBundleTree(sourceDir),
      inventoryBundleTree(extractedDir),
    ]);

    if (source.length !== expectedFileCount) {
      throw new Error(
        `[bundle-archive] source file count ${source.length} does not match metadata ${expectedFileCount}`,
      );
    }
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
