import type { PortableFileEntry, PortableFileSystem } from '@bendyline/gezel/runtime';

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

export interface ProductFilePlugin {
  readProductFile(options: { path: string }): Promise<{ data: string | null }>;
  writeProductFile(options: { path: string; data: string }): Promise<void>;
  listProductFiles(options: { path: string }): Promise<{ entries: PortableFileEntry[] }>;
  mkdirProductDirectory(options: { path: string }): Promise<void>;
  removeProductPath(options: { path: string }): Promise<void>;
  renameProductPath(options: { from: string; to: string }): Promise<void>;
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

export function createNativeProductFiles(plugin: ProductFilePlugin): PortableFileSystem {
  return {
    async read(path) {
      validateProductPath(path);
      const { data } = await plugin.readProductFile({ path });
      return data === null ? null : decodeBytes(data);
    },
    async write(path, bytes) {
      validateProductPath(path);
      await plugin.writeProductFile({ path, data: encodeBytes(bytes) });
    },
    async list(path) {
      validateProductPath(path, true);
      const { entries } = await plugin.listProductFiles({ path });
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
      await plugin.mkdirProductDirectory({ path });
    },
    async remove(path) {
      validateProductPath(path);
      await plugin.removeProductPath({ path });
    },
    async rename(from, to) {
      validateProductPath(from);
      validateProductPath(to);
      if (to.startsWith(`${from}/`)) throw new Error('Cannot move a directory inside itself.');
      await plugin.renameProductPath({ from, to });
    },
  };
}
