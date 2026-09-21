import type { z } from 'zod';
import { assertSafeEntityId } from '../entity-id.js';
import { KeyedLock } from '../keyed-lock.js';
import {
  PORTABLE_MAX_RECORD_BYTES,
  type PortableFileEntry,
  type PortableFileSystem,
  encodeText,
  readText,
  validatePortablePath,
} from './files.js';
import { PortableTransactions } from './transactions.js';

export interface PortableStoreOptions {
  files: PortableFileSystem;
  version?: string;
  now?: () => string;
  createId?: () => string;
}

export class PortableRepository {
  readonly files: PortableFileSystem;
  readonly now: () => string;
  readonly createId: () => string;
  readonly version: string;
  readonly transactions: PortableTransactions;
  private readonly lock = new KeyedLock();

  constructor(options: PortableStoreOptions) {
    this.files = options.files;
    this.version = options.version ?? '0.0.0';
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId = options.createId ?? (() => globalThis.crypto.randomUUID());
    this.transactions = new PortableTransactions(this.files, this.createId);
  }

  run<T>(operation: () => Promise<T>): Promise<T> {
    return this.lock.run('product', async () => {
      await this.transactions.recover();
      return operation();
    });
  }

  text(path: string): Promise<string | null> {
    return readText(this.files, path);
  }
  async record<T>(path: string, schema: z.ZodType<T>): Promise<T | null> {
    const raw = await readText(this.files, path, PORTABLE_MAX_RECORD_BYTES);
    return raw === null ? null : schema.parse(JSON.parse(raw));
  }
  json(value: unknown): Uint8Array {
    const bytes = encodeText(`${JSON.stringify(value, null, 2)}\n`);
    if (bytes.byteLength > PORTABLE_MAX_RECORD_BYTES)
      throw new Error('Product record exceeds its size limit');
    return bytes;
  }
  async list(path: string): Promise<PortableFileEntry[]> {
    validatePortablePath(path, true);
    if (path) {
      const entry = await this.stat(path);
      if (!entry) return [];
      if (!entry.isDirectory) throw new Error('Expected a directory');
    }
    return this.files.list(path);
  }
  async stat(path: string): Promise<PortableFileEntry | undefined> {
    validatePortablePath(path);
    const slash = path.lastIndexOf('/');
    return (await this.list(slash < 0 ? '' : path.slice(0, slash))).find(
      (entry) => entry.name === path.slice(slash + 1),
    );
  }
  async exists(path: string): Promise<boolean> {
    return !!(await this.stat(path));
  }
  async uniqueId(folder: string, base: string): Promise<string> {
    assertSafeEntityId(base);
    for (let suffix = 1; suffix < 10000; suffix++) {
      const candidate = suffix === 1 ? base : `${base}-${suffix}`;
      if (!(await this.exists(`${folder}/${candidate}`))) return candidate;
    }
    throw new Error(`No free identifier for ${base}`);
  }
  async tree(path: string): Promise<string[]> {
    const paths: string[] = [];
    const walk = async (root: string, depth: number): Promise<void> => {
      if (depth > 64) throw new Error('Directory exceeds the supported nesting depth');
      for (const entry of await this.list(root)) {
        const next = validatePortablePath(`${root}/${entry.name}`);
        if (paths.length >= 10000) throw new Error('Directory exceeds the supported file count');
        paths.push(next);
        if (entry.isDirectory) await walk(next, depth + 1);
      }
    };
    await walk(path, 0);
    return paths;
  }
}
