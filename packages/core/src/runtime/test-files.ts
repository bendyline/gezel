import { type PortableFileEntry, type PortableFileSystem, validatePortablePath } from './files.js';
import { PortableStore } from './store.js';

/** Strict port: unlike permissive mocks, directory reads and absent lists fail. */
export class MemoryFiles implements PortableFileSystem {
  readonly entries = new Map<string, Uint8Array | null>([['', null]]);
  fault: ((operation: string, path: string) => boolean) | undefined;
  private check(op: string, path: string) {
    validatePortablePath(path, op === 'list' || op === 'mkdir');
    if (this.fault?.(op, path)) throw new Error('Disk unavailable');
  }
  async read(path: string) {
    this.check('read', path);
    const value = this.entries.get(path);
    if (value === null) throw new Error('Cannot read directory');
    return value?.slice() ?? null;
  }
  async write(path: string, data: Uint8Array) {
    this.check('write', path);
    const slash = path.lastIndexOf('/');
    const parent = slash < 0 ? '' : path.slice(0, slash);
    if (this.entries.get(parent) !== null) throw new Error('Parent missing');
    if (this.entries.get(path) === null) throw new Error('Cannot replace directory');
    this.entries.set(path, data.slice());
  }
  async list(path: string): Promise<PortableFileEntry[]> {
    this.check('list', path);
    if (this.entries.get(path) !== null) throw new Error('Directory missing');
    const prefix = path ? `${path}/` : '';
    return [...this.entries].flatMap(([key, value]) => {
      const name = key.slice(prefix.length);
      return key.startsWith(prefix) && name && !name.includes('/')
        ? [
            {
              name,
              isDirectory: value === null,
              size: value?.byteLength ?? 0,
              mtime: Date.parse('2026-09-20T12:00:00Z'),
            },
          ]
        : [];
    });
  }
  async mkdir(path: string) {
    this.check('mkdir', path);
    let current = '';
    for (const part of path.split('/').filter(Boolean)) {
      current = current ? `${current}/${part}` : part;
      if (this.entries.has(current) && this.entries.get(current) !== null)
        throw new Error('File blocks directory');
      this.entries.set(current, null);
    }
  }
  async remove(path: string) {
    this.check('remove', path);
    for (const key of this.entries.keys())
      if (key === path || key.startsWith(`${path}/`)) this.entries.delete(key);
  }
  async rename(from: string, to: string) {
    this.check('rename', from);
    validatePortablePath(to);
    if (!this.entries.has(from) || this.entries.has(to)) throw new Error('Invalid rename');
    for (const [key, value] of [...this.entries])
      if (key === from || key.startsWith(`${from}/`)) {
        this.entries.set(`${to}${key.slice(from.length)}`, value);
        this.entries.delete(key);
      }
  }
}
export function portableFixture() {
  const files = new MemoryFiles();
  let id = 0;
  const options = { files, createId: () => `generated-${++id}`, now: () => '2026-09-20T12:00:00Z' };
  return { files, options, store: new PortableStore(options) };
}
