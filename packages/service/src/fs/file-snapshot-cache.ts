import type { Stats } from 'node:fs';
import { stat } from 'node:fs/promises';

/** A bounded, disposable read cache. Every read checks the file on disk. */
export class FileSnapshotCache<T> {
  private entries = new Map<
    string,
    {
      identity: string;
      bytes: number;
      value: Promise<T | null>;
    }
  >();
  private bytes = 0;
  constructor(
    private maxBytes = 32 * 1024 * 1024,
    private maxEntries = 2_000,
  ) {}

  async read(path: string, load: () => Promise<T | null>): Promise<T | null> {
    let info: Stats;
    try {
      info = await stat(path);
    } catch (error) {
      this.invalidate(path);
      const code = (error as NodeJS.ErrnoException).code;
      // Let each reader retain its existing diagnostics/error policy for
      // inaccessible files. Only absence has a universal meaning here.
      return code === 'ENOENT' || code === 'ENOTDIR' ? null : load();
    }
    const identity = `${info.ino}:${info.mtimeMs}:${info.ctimeMs}:${info.size}`;
    const hit = this.entries.get(path);
    if (hit?.identity === identity) {
      this.entries.delete(path);
      this.entries.set(path, hit);
      return hit.value;
    }
    this.invalidate(path);
    const entry = { identity, bytes: info.size, value: Promise.resolve().then(load) };
    if (info.size <= this.maxBytes) {
      this.entries.set(path, entry);
      this.bytes += info.size;
      while (this.bytes > this.maxBytes || this.entries.size > this.maxEntries) {
        this.invalidate(this.entries.keys().next().value!);
      }
    }
    try {
      const value = await entry.value;
      if (value === null && this.entries.get(path) === entry) this.invalidate(path);
      return value;
    } catch (error) {
      if (this.entries.get(path) === entry) this.invalidate(path);
      throw error;
    }
  }

  invalidate(path: string): void {
    const entry = this.entries.get(path);
    if (entry) this.bytes -= entry.bytes;
    this.entries.delete(path);
  }
}
