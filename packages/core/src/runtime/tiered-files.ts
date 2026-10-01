import { type StorageTier, storageTierFor } from '../storage-tiers.js';
import type { PortableFileEntry, PortableFileSystem } from './files.js';

/**
 * One product namespace over two roots: Work paths go where the person keeps
 * their files, Device paths stay in the app's own storage. Product code keeps
 * using ordinary relative paths and never learns which root holds a file.
 *
 * A directory can hold both tiers (a project's `artifacts/` holds Work files
 * and the Device `shadow/` cache), so listings merge both roots, removal
 * clears both, and a rename moves whatever each root holds.
 */
export function createTieredFileSystem(
  roots: Record<StorageTier, PortableFileSystem>,
  tierFor: (path: string) => StorageTier = storageTierFor,
): PortableFileSystem {
  const rootFor = (path: string) => roots[tierFor(path)];
  const both = [roots.work, roots.device] as const;

  async function listed(files: PortableFileSystem, path: string) {
    try {
      return await files.list(path);
    } catch {
      return undefined;
    }
  }

  async function exists(files: PortableFileSystem, path: string) {
    if ((await files.read(path).catch(() => null)) !== null) return true;
    return (await listed(files, path)) !== undefined;
  }

  async function parentOf(files: PortableFileSystem, path: string) {
    const slash = path.lastIndexOf('/');
    if (slash > 0) await files.mkdir(path.slice(0, slash));
  }

  /** Moves a subtree file by file, each file to the root its new path belongs to. */
  async function copyTree(from: PortableFileSystem, source: string, target: string) {
    const bytes = await from.read(source).catch(() => null);
    if (bytes !== null) {
      const destination = rootFor(target);
      await parentOf(destination, target);
      await destination.write(target, bytes);
      return;
    }
    await rootFor(target).mkdir(target);
    for (const entry of (await listed(from, source)) ?? [])
      await copyTree(from, `${source}/${entry.name}`, `${target}/${entry.name}`);
  }

  return {
    read: (path) => rootFor(path).read(path),
    write: async (path, bytes) => {
      const files = rootFor(path);
      try {
        await files.write(path, bytes);
      } catch (error) {
        // Its parent may exist only on the other root, created there by a
        // Device child's mkdir (`artifacts/` by `artifacts/shadow/`). Making
        // it only on failure keeps the common write to one native call.
        if (!path.includes('/')) throw error;
        await parentOf(files, path);
        await files.write(path, bytes);
      }
    },
    async list(path) {
      const [work, device] = await Promise.all(both.map((files) => listed(files, path)));
      if (!work && !device) throw new Error('Directory missing');
      const merged = new Map<string, PortableFileEntry>();
      for (const entry of [...(work ?? []), ...(device ?? [])])
        if (!merged.has(entry.name) || entry.isDirectory) merged.set(entry.name, entry);
      return [...merged.values()];
    },
    mkdir: (path) => rootFor(path).mkdir(path),
    async remove(path) {
      await Promise.all(both.map((files) => files.remove(path)));
    },
    async rename(from, to) {
      if (
        await Promise.all(both.map((files) => exists(files, to))).then((hits) => hits.some(Boolean))
      )
        throw new Error('Rename target exists');
      let moved = false;
      for (const files of both) {
        if (!(await exists(files, from))) continue;
        moved = true;
        if (files === rootFor(to) && files === rootFor(from)) {
          await parentOf(files, to);
          await files.rename(from, to);
        } else {
          await copyTree(files, from, to);
          await files.remove(from);
        }
      }
      if (!moved) throw new Error('Rename source missing');
    },
  };
}
