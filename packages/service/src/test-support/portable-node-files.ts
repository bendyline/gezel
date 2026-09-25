/**
 * A node-backed `PortableFileSystem`, for tests only.
 *
 * Both hosts write the same on-disk layout, so a contract test can write a
 * fixture with the desktop `Store` and read it back through `PortableStore`,
 * or the other way round. That is the only reason this adapter exists: the
 * desktop product never runs on the portable repository (its locking and
 * multi-root paths would regress), and nothing here is exported from the
 * package entry.
 */
import { access, mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { PortableStore, type PortableStoreOptions } from '@bendyline/gezel/runtime';
import type { PortableFileEntry, PortableFileSystem } from '@bendyline/gezel/runtime';
import { writeFileAtomic } from '../fs/atomic.js';

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

export class NodePortableFiles implements PortableFileSystem {
  constructor(private readonly root: string) {}

  private abs(path: string): string {
    return path ? join(this.root, path) : this.root;
  }

  async read(path: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(this.abs(path)));
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }

  async write(path: string, bytes: Uint8Array): Promise<void> {
    await writeFileAtomic(this.abs(path), bytes);
  }

  async list(path: string): Promise<PortableFileEntry[]> {
    let names: import('node:fs').Dirent[];
    try {
      names = await readdir(this.abs(path), { withFileTypes: true });
    } catch (error) {
      if (missing(error)) return [];
      throw error;
    }
    const entries: PortableFileEntry[] = [];
    for (const entry of names) {
      const info = await stat(join(this.abs(path), entry.name));
      entries.push({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        size: info.size,
        mtime: info.mtimeMs,
      });
    }
    return entries;
  }

  async mkdir(path: string): Promise<void> {
    await mkdir(this.abs(path), { recursive: true });
  }

  async remove(path: string): Promise<void> {
    await rm(this.abs(path), { recursive: true, force: true });
  }

  async rename(from: string, to: string): Promise<void> {
    let exists = true;
    try {
      await access(this.abs(to));
    } catch {
      exists = false;
    }
    if (exists) throw new Error(`Refusing to replace ${to}`);
    await rename(this.abs(from), this.abs(to));
  }
}

/** A `PortableStore` reading and writing a desktop home directory. */
export function portableStoreOverHome(
  home: string,
  options: Omit<PortableStoreOptions, 'files'> = {},
): PortableStore {
  return new PortableStore({ files: new NodePortableFiles(home), ...options });
}
