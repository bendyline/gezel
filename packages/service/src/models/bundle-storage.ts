import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { safeJoin } from '../fs/safe-paths.js';
import { assertModelStorePathSafe } from './storage-roots.js';

/** Provider-owned view of an installed model used by the bundle exporter. */
export interface ModelBundleSource {
  id: string;
  name: string;
  modelDir: string;
  installedManifest: Record<string, unknown>;
  /** Model-dir-relative POSIX paths. `manifest.json` is intentionally absent. */
  modelFiles: string[];
  catalogVersion?: string;
}

/**
 * Enumerate only ordinary files below `root`. Symbolic links and other special
 * entries are refused rather than followed; a model export must never smuggle
 * bytes from outside its provider-owned directory into a share bundle.
 */
export async function listBundleModelFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`model contains a symbolic link, which cannot be exported: ${entry.name}`);
      }
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(
          `model contains a non-regular file, which cannot be exported: ${entry.name}`,
        );
      }
      const rel = relative(root, full).split(sep).join('/');
      if (rel === 'manifest.json' || rel.endsWith('.partial')) continue;
      out.push(rel);
    }
  };
  await walk(root);
  return out.sort();
}

export function safeBundleModelPath(root: string, rel: string): string {
  const resolved = safeJoin(root, rel);
  if (!resolved) throw new Error(`unsafe model file path: ${rel}`);
  return resolved;
}

/**
 * Atomically publish a fully-scanned staged model directory. Replacement keeps
 * the old install beside the target until the final rename succeeds, then
 * removes the backup. A failed publish restores the old directory.
 */
export async function publishStagedModel(opts: {
  modelsRoot: string;
  id: string;
  stagedModelDir: string;
  replace: boolean;
}): Promise<void> {
  await mkdir(opts.modelsRoot, { recursive: true });
  const target = safeJoin(opts.modelsRoot, opts.id);
  if (!target) throw new Error(`unsafe model id: ${opts.id}`);
  await assertModelStorePathSafe(opts.modelsRoot, target);

  let exists = false;
  try {
    exists = (await stat(target)).isDirectory();
  } catch {
    exists = false;
  }
  if (exists && !opts.replace) {
    throw new Error(`model "${opts.id}" already exists locally`);
  }

  const backup = join(dirname(target), `.${opts.id}.gezmodel-backup-${randomUUID()}`);
  if (exists) await rename(target, backup);
  let published = false;
  try {
    await rename(opts.stagedModelDir, target);
    published = true;
    await assertModelStorePathSafe(opts.modelsRoot, target);
  } catch (err) {
    if (published) await rm(target, { recursive: true, force: true }).catch(() => {});
    if (exists) await rename(backup, target).catch(() => {});
    throw err;
  }
  if (exists) await rm(backup, { recursive: true, force: true });
}
