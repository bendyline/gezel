import {
  type PortableFileEntry,
  type PortableFileSystem,
  createTieredFileSystem,
} from '@bendyline/gezel/runtime';

export const MAX_PRODUCT_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_PRODUCT_ENTRIES = 10000;
const encoder = new TextEncoder();

export function validateProductPath(path: string, allowRoot = false): void {
  if (
    typeof path !== 'string' ||
    (!allowRoot && !path) ||
    encoder.encode(path).length > 4096 ||
    path.includes('\\') ||
    path.includes('\0')
  ) {
    throw new Error('Use a relative path inside Gezel’s product files.');
  }
  if (!path && allowRoot) return;
  const parts = path.split('/');
  if (
    parts.length > 128 ||
    parts.some(
      (part) => !part || part === '.' || part === '..' || encoder.encode(part).length > 255,
    )
  ) {
    throw new Error('Use a relative path inside Gezel’s product files.');
  }
}

/** Which native root a call addresses; omitted means the app's own product tree. */
type ProductRoot = { root?: 'work' };

/** Where the person's work lives, when the device has a home for it outside the app. */
export interface ProductStorage {
  work: { kind: 'icloud' | 'folder'; name: string } | null;
}

export interface ProductFilePlugin {
  readProductFile(options: { path: string } & ProductRoot): Promise<{ data: string | null }>;
  writeProductFile(options: { path: string; data: string } & ProductRoot): Promise<void>;
  listProductFiles(
    options: { path: string } & ProductRoot,
  ): Promise<{ entries: PortableFileEntry[] }>;
  mkdirProductDirectory(options: { path: string } & ProductRoot): Promise<void>;
  removeProductPath(options: { path: string } & ProductRoot): Promise<void>;
  renameProductPath(options: { from: string; to: string } & ProductRoot): Promise<void>;
  productStorage?(): Promise<ProductStorage>;
}

function encodeBytes(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array) || bytes.length > MAX_PRODUCT_FILE_BYTES)
    throw new Error('Product files are limited to 16 MiB.');
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}

function decodeBytes(encoded: string): Uint8Array {
  if (
    typeof encoded !== 'string' ||
    encoded.length > Math.ceil(MAX_PRODUCT_FILE_BYTES / 3) * 4 ||
    encoded.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
  ) {
    throw new Error('The native product file is invalid or exceeds 16 MiB.');
  }
  const binary = atob(encoded);
  if (binary.length > MAX_PRODUCT_FILE_BYTES || btoa(binary) !== encoded)
    throw new Error('The native product file is invalid or exceeds 16 MiB.');
  return Uint8Array.from(binary, (value) => value.charCodeAt(0));
}

export function createNativeProductFiles(
  plugin: ProductFilePlugin,
  root?: 'work',
): PortableFileSystem {
  const at = root ? { root } : {};
  return {
    async read(path) {
      validateProductPath(path);
      const { data } = await plugin.readProductFile({ path, ...at });
      return data === null ? null : decodeBytes(data);
    },
    async write(path, bytes) {
      validateProductPath(path);
      await plugin.writeProductFile({ path, data: encodeBytes(bytes), ...at });
    },
    async list(path) {
      validateProductPath(path, true);
      const { entries } = await plugin.listProductFiles({ path, ...at });
      if (!Array.isArray(entries) || entries.length > MAX_PRODUCT_ENTRIES)
        throw new Error('The native product directory is invalid.');
      const names = new Set<string>();
      for (const entry of entries) {
        validateProductPath(entry.name);
        if (
          entry.name.includes('/') ||
          names.has(entry.name) ||
          typeof entry.isDirectory !== 'boolean' ||
          !Number.isSafeInteger(entry.size) ||
          entry.size < 0 ||
          !Number.isFinite(entry.mtime) ||
          entry.mtime < 0
        )
          throw new Error('The native product directory is invalid.');
        names.add(entry.name);
      }
      return entries;
    },
    async mkdir(path) {
      validateProductPath(path, true);
      await plugin.mkdirProductDirectory({ path, ...at });
    },
    async remove(path) {
      validateProductPath(path);
      await plugin.removeProductPath({ path, ...at });
    },
    async rename(from, to) {
      validateProductPath(from);
      validateProductPath(to);
      if (to.startsWith(`${from}/`)) throw new Error('Cannot move a directory inside itself.');
      await plugin.renameProductPath({ from, to, ...at });
    },
  };
}

/**
 * The product's files with the person's work routed to where it outlives the
 * app (iCloud Drive, a picked folder) and everything else in the app's own
 * tree, by the classifier the desktop shares. The native side is asked once,
 * on first use; a device with no such home keeps the single app-owned tree.
 */
export function createRoutedProductFiles(plugin: ProductFilePlugin): PortableFileSystem {
  let resolved: Promise<PortableFileSystem> | undefined;
  const files = () => {
    resolved ??= (async () => {
      const storage = await plugin.productStorage?.().catch(() => undefined);
      const device = createNativeProductFiles(plugin);
      return storage?.work
        ? createTieredFileSystem({ work: createNativeProductFiles(plugin, 'work'), device })
        : device;
    })();
    return resolved;
  };
  return {
    read: async (path) => (await files()).read(path),
    write: async (path, bytes) => (await files()).write(path, bytes),
    list: async (path) => (await files()).list(path),
    mkdir: async (path) => (await files()).mkdir(path),
    remove: async (path) => (await files()).remove(path),
    rename: async (from, to) => (await files()).rename(from, to),
  };
}
