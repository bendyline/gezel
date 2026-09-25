import type { PortableFileEntry, PortableFileSystem } from '@bendyline/gezel/runtime';
import {
  MAX_PRODUCT_ENTRIES,
  MAX_PRODUCT_FILE_BYTES,
  validateProductPath,
} from './product-files.js';

interface Metadata {
  directory: boolean;
  size: number;
  mtime: number;
  revision?: number;
}
const FILES = 'product-files';
const BYTES = 'product-bytes';
const conflict = () =>
  new Error('Product files changed in another preview tab. Reload this tab before continuing.');

export function browserDatabase(name = 'gezel-mobile-product'): () => Promise<IDBDatabase> {
  let database: Promise<IDBDatabase> | undefined;
  return () => {
    database ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(FILES)) {
          const files = db.createObjectStore(FILES);
          files.put({ directory: true, size: 0, mtime: Date.now(), revision: 0 }, '');
        }
        if (!db.objectStoreNames.contains(BYTES)) db.createObjectStore(BYTES);
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => {
          request.result.close();
          database = undefined;
        };
        resolve(request.result);
      };
      request.onerror = () => reject(request.error ?? new Error('Cannot open product storage.'));
      request.onblocked = () =>
        reject(new Error('Close other preview tabs to open product storage.'));
    });
    return database;
  };
}

function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Product storage request failed.'));
  });
}

function parent(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

export function createBrowserProductFiles(open = browserDatabase()): PortableFileSystem {
  let expectedRevision: number | undefined;
  let queue = Promise.resolve();

  function transaction<T>(
    mutate: boolean,
    action: (files: IDBObjectStore, bytes: IDBObjectStore) => Promise<T>,
  ): Promise<T> {
    const task = queue.then(async () => {
      const db = await open();
      return new Promise<T>((resolve, reject) => {
        const tx = db.transaction([FILES, BYTES], mutate ? 'readwrite' : 'readonly');
        const files = tx.objectStore(FILES);
        const bytes = tx.objectStore(BYTES);
        let output: T;
        let nextRevision: number;
        let failure: unknown;
        tx.oncomplete = () => {
          expectedRevision = nextRevision;
          resolve(output);
        };
        tx.onabort = () =>
          reject(failure ?? tx.error ?? new Error('Cannot access product storage.'));
        void (async () => {
          const root = await result<Metadata | undefined>(files.get(''));
          if (!root?.directory || !Number.isSafeInteger(root.revision) || root.revision! < 0)
            throw new Error('Product storage metadata is invalid.');
          if (expectedRevision !== undefined && expectedRevision !== root.revision)
            throw conflict();
          output = await action(files, bytes);
          nextRevision = root.revision! + (mutate ? 1 : 0);
          if (mutate)
            await result(files.put({ ...root, revision: nextRevision, mtime: Date.now() }, ''));
        })().catch((error: unknown) => {
          failure = error;
          try {
            tx.abort();
          } catch {
            reject(error);
          }
        });
      });
    });
    queue = task.then(
      () => {},
      () => {},
    );
    return task;
  }

  async function requireParent(files: IDBObjectStore, path: string): Promise<void> {
    const metadata = await result<Metadata | undefined>(files.get(parent(path)));
    if (!metadata?.directory) throw new Error('The product directory does not exist.');
  }

  async function descendants(
    files: IDBObjectStore,
    path: string,
  ): Promise<Array<[string, Metadata]>> {
    const keys = await result(files.getAllKeys(undefined, MAX_PRODUCT_ENTRIES + 1));
    if (keys.length > MAX_PRODUCT_ENTRIES)
      throw new Error('Product storage contains too many files.');
    const relevant = keys.filter(
      (key): key is string =>
        typeof key === 'string' && (key === path || key.startsWith(`${path}/`)),
    );
    return Promise.all(
      relevant.map(
        async (key) => [key, await result<Metadata>(files.get(key))] as [string, Metadata],
      ),
    );
  }

  return {
    async read(path) {
      validateProductPath(path);
      return transaction(false, async (files, bytes) => {
        const metadata = await result<Metadata | undefined>(files.get(path));
        if (!metadata) return null;
        if (metadata.directory) throw new Error('This path is not a product file.');
        if (metadata.size > MAX_PRODUCT_FILE_BYTES)
          throw new Error('Product files are limited to 16 MiB.');
        const data = await result<Uint8Array | undefined>(bytes.get(path));
        if (
          !(data instanceof Uint8Array) ||
          data.length !== metadata.size ||
          data.length > MAX_PRODUCT_FILE_BYTES
        )
          throw new Error('The product file is unreadable.');
        return data;
      });
    },
    async write(path, data) {
      validateProductPath(path);
      if (!(data instanceof Uint8Array) || data.length > MAX_PRODUCT_FILE_BYTES)
        throw new Error('Product files are limited to 16 MiB.');
      const copy = data.slice();
      return transaction(true, async (files, bytes) => {
        await requireParent(files, path);
        const metadata = await result<Metadata | undefined>(files.get(path));
        if (metadata?.directory) throw new Error('This path is not a product file.');
        if (!metadata && (await result(files.count())) >= MAX_PRODUCT_ENTRIES)
          throw new Error('Product storage contains too many files.');
        await result(bytes.put(copy, path));
        await result(files.put({ directory: false, size: copy.length, mtime: Date.now() }, path));
      });
    },
    async list(path) {
      validateProductPath(path, true);
      return transaction(false, async (files) => {
        const folder = await result<Metadata | undefined>(files.get(path));
        if (!folder?.directory) throw new Error('The product directory does not exist.');
        const keys = await result(files.getAllKeys(undefined, MAX_PRODUCT_ENTRIES + 1));
        if (keys.length > MAX_PRODUCT_ENTRIES)
          throw new Error('Product storage contains too many files.');
        const children = keys.filter(
          (key): key is string => typeof key === 'string' && key !== '' && parent(key) === path,
        );
        const entries: PortableFileEntry[] = await Promise.all(
          children.map(async (key) => {
            const metadata = await result<Metadata>(files.get(key));
            return {
              name: key.slice(path ? path.length + 1 : 0),
              isDirectory: metadata.directory,
              size: metadata.size,
              mtime: metadata.mtime,
            };
          }),
        );
        return entries.sort((a, b) => a.name.localeCompare(b.name));
      });
    },
    async mkdir(path) {
      validateProductPath(path, true);
      return transaction(Boolean(path), async (files) => {
        if (!path) return;
        let current = '';
        for (const part of path.split('/')) {
          current = current ? `${current}/${part}` : part;
          const existing = await result<Metadata | undefined>(files.get(current));
          if (existing && !existing.directory)
            throw new Error('This path is not a product directory.');
          if (!existing) {
            if ((await result(files.count())) >= MAX_PRODUCT_ENTRIES)
              throw new Error('Product storage contains too many files.');
            await result(files.put({ directory: true, size: 0, mtime: Date.now() }, current));
          }
        }
      });
    },
    async remove(path) {
      validateProductPath(path);
      return transaction(true, async (files, bytes) => {
        for (const [key] of await descendants(files, path)) {
          await result(bytes.delete(key));
          await result(files.delete(key));
        }
      });
    },
    async rename(from, to) {
      validateProductPath(from);
      validateProductPath(to);
      if (to.startsWith(`${from}/`)) throw new Error('Cannot move a directory inside itself.');
      return transaction(true, async (files, bytes) => {
        if (!(await result(files.get(from))))
          throw new Error('The source product path does not exist.');
        if (await result(files.get(to))) throw new Error('The destination already exists.');
        await requireParent(files, to);
        for (const [key, metadata] of await descendants(files, from)) {
          const destination = to + key.slice(from.length);
          validateProductPath(destination);
          if (!metadata.directory) {
            const data = await result(bytes.get(key));
            await result(bytes.put(data, destination));
            await result(bytes.delete(key));
          }
          await result(files.put(metadata, destination));
          await result(files.delete(key));
        }
      });
    },
  };
}
