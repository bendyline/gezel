/** Regenerable llama.cpp snapshots share one bounded cache across model replicas. */
import { lstat, readdir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export const DEFAULT_LLAMA_DISK_CACHE_MB = 8192;
const operations = new Map<string, Promise<void>>();

/** Save, restore and eviction must not race another replica's pruning. */
export async function withLlamaDiskCache<T>(root: string, work: () => Promise<T>): Promise<T> {
  const absolute = resolve(root);
  const key = process.platform === 'win32' ? absolute.toLowerCase() : absolute;
  const previous = operations.get(key) ?? Promise.resolve();
  let release!: () => void;
  const tail = new Promise<void>((done) => {
    release = done;
  });
  operations.set(key, tail);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (operations.get(key) === tail) operations.delete(key);
  }
}

export async function pruneLlamaDiskCache(root: string, budgetBytes: number) {
  if (!Number.isSafeInteger(budgetBytes) || budgetBytes < 0)
    throw new Error('Invalid llama disk cache budget');
  const result = { bytes: 0, removedBytes: 0, removedFiles: 0 };
  if (budgetBytes === 0) return result; // Explicit operator opt-out.
  const files: Array<{
    path: string;
    size: number;
    mtimeMs: number;
    ino: number;
    dev: number;
    parents: string[];
  }> = [];
  const directories = new Map<string, { ino: number; dev: number }>();
  async function visit(dir: string, depth: number, parents: string[]): Promise<void> {
    // Never traverse directory symlinks/junctions, including a replaced root.
    const info = await lstat(dir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!info?.isDirectory() || info.isSymbolicLink()) return;
    directories.set(dir, { ino: info.ino, dev: info.dev });
    const ancestors = [...parents, dir];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (
          (depth === 0 && /^[a-f0-9]{24}$/.test(entry.name)) ||
          (depth === 1 && /^replica-[1-9]\d*$/.test(entry.name))
        )
          await visit(path, depth + 1, ancestors);
        continue;
      }
      if (
        !entry.isFile() ||
        !/^(?:sess-[A-Za-z0-9._-]+|prefix-(?:(?:gp|gezel)-)?[a-f0-9]{16})\.bin$/.test(entry.name)
      )
        continue;
      const stat = await lstat(path).catch(() => null);
      if (!stat?.isFile() || stat.isSymbolicLink()) continue;
      files.push({
        path,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ino: stat.ino,
        dev: stat.dev,
        parents: ancestors,
      });
      result.bytes += stat.size;
    }
  }
  await visit(resolve(root), 0, []);
  files.sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path));
  for (const file of files) {
    if (result.bytes <= budgetBytes) break;
    try {
      let safe = true;
      for (const parent of file.parents) {
        const expected = directories.get(parent)!;
        const current = await lstat(parent);
        if (
          !current.isDirectory() ||
          current.isSymbolicLink() ||
          current.ino !== expected.ino ||
          current.dev !== expected.dev
        ) {
          safe = false;
          break;
        }
      }
      if (!safe) continue;
      // External writers are not in the process-local lock. Do not evict an
      // entry whose identity or contents changed since the inventory scan.
      const current = await lstat(file.path);
      if (
        !current.isFile() ||
        current.isSymbolicLink() ||
        current.ino !== file.ino ||
        current.dev !== file.dev ||
        current.size !== file.size ||
        current.mtimeMs !== file.mtimeMs
      )
        continue;
      await unlink(file.path);
      result.bytes -= file.size;
      result.removedBytes += file.size;
      result.removedFiles++;
    } catch {
      // A missing/locked cache is harmless; retry retention on the next turn.
    }
  }
  return result;
}
