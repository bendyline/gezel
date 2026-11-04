import type { Sqlite3Static } from '@sqlite.org/sqlite-wasm';
import type { RawFiles } from './files.js';

// sqlite-wasm's typings omit the `$`-prefixed struct members its own VFSes use.
interface Struct {
  readonly pointer: number;
  dispose(): void;
  [member: `$${string}`]: unknown;
}
type Method = (...args: never[]) => number;
interface LowLevel {
  sqlite3_io_methods: new () => Struct;
  sqlite3_vfs: new (pointer?: number) => Struct;
  sqlite3_file: (new (pointer: number) => Struct) & { structInfo: { sizeof: number } };
  sqlite3_vfs_find(name: string | null): number;
  SQLITE_IOERR_READ: number;
  SQLITE_IOERR_SHORT_READ: number;
  SQLITE_READONLY: number;
  SQLITE_NOTFOUND: number;
  SQLITE_IOCAP_IMMUTABLE: number;
  SQLITE_OPEN_MAIN_DB: number;
  SQLITE_OPEN_READONLY: number;
  SQLITE_CANTOPEN: number;
}
interface Installer {
  installVfs(options: {
    io?: { struct: Struct; methods: Record<string, Method> };
    vfs?: { struct: Struct; name: string; methods: Record<string, Method> };
  }): void;
}

/** Reads per round trip; SQLite pages are 4 KiB, so this batches about sixteen. */
const BLOCK = 64 * 1024;

/**
 * A read-only SQLite VFS over synchronous range reads, for immutable catalog
 * files. Blocks are cached LRU, so repeated queries rarely leave the worker.
 */
export function installRangeVfs(
  sqlite3: Sqlite3Static,
  name: string,
  files: RawFiles,
  cacheBytes = 32 * 1024 * 1024,
): void {
  const capi = sqlite3.capi as unknown as LowLevel;
  const { wasm } = sqlite3;
  const installer = sqlite3.vfs as unknown as Installer;
  const open = new Map<number, { path: string; size: number }>();
  const cache = new Map<string, Uint8Array>();
  let cached = 0;
  const block = (path: string, index: number, size: number) => {
    const key = `${index}:${path}`;
    const hit = cache.get(key);
    if (hit) {
      cache.delete(key);
      cache.set(key, hit);
      return hit;
    }
    const bytes = files.read(path, index * BLOCK, Math.min(BLOCK, size - index * BLOCK));
    cache.set(key, bytes);
    cached += bytes.byteLength;
    for (const [oldKey, old] of cache) {
      if (cached <= cacheBytes) break;
      cache.delete(oldKey);
      cached -= old.byteLength;
    }
    return bytes;
  };

  const io = new capi.sqlite3_io_methods();
  io.$iVersion = 1;
  installer.installVfs({
    io: {
      struct: io,
      methods: {
        xClose(pFile: number) {
          open.delete(Number(pFile));
          return 0;
        },
        xRead(pFile: number, pDest: number, n: number, offset64: number | bigint) {
          const file = open.get(Number(pFile));
          if (!file) return capi.SQLITE_IOERR_READ;
          const heap = wasm.heap8u();
          const dest = Number(pDest);
          let offset = Number(offset64);
          let written = 0;
          try {
            while (written < n && offset < file.size) {
              const index = Math.floor(offset / BLOCK);
              const bytes = block(file.path, index, file.size);
              const start = offset - index * BLOCK;
              const take = Math.min(n - written, bytes.byteLength - start);
              if (take <= 0) break;
              heap.set(bytes.subarray(start, start + take), dest + written);
              written += take;
              offset += take;
            }
          } catch {
            return capi.SQLITE_IOERR_READ;
          }
          if (written < n) {
            heap.fill(0, dest + written, dest + n);
            return capi.SQLITE_IOERR_SHORT_READ;
          }
          return 0;
        },
        xWrite: () => capi.SQLITE_READONLY,
        xTruncate: () => capi.SQLITE_READONLY,
        xSync: () => 0,
        xFileSize(pFile: number, pSize: number) {
          wasm.poke64(pSize, BigInt(open.get(Number(pFile))?.size ?? 0));
          return 0;
        },
        xLock: () => 0,
        xUnlock: () => 0,
        xCheckReservedLock(_pFile: number, pOut: number) {
          wasm.poke32(pOut, 0);
          return 0;
        },
        xFileControl: () => capi.SQLITE_NOTFOUND,
        xSectorSize: () => 4096,
        xDeviceCharacteristics: () => capi.SQLITE_IOCAP_IMMUTABLE,
      },
    },
  });

  const vfs = new capi.sqlite3_vfs();
  const fallback = capi.sqlite3_vfs_find(null);
  if (fallback) {
    const base = new capi.sqlite3_vfs(fallback);
    vfs.$xRandomness = base.$xRandomness;
    vfs.$xSleep = base.$xSleep;
    vfs.$xCurrentTime = base.$xCurrentTime;
    vfs.$xCurrentTimeInt64 = base.$xCurrentTimeInt64;
    base.dispose();
  }
  vfs.$iVersion = 2;
  vfs.$szOsFile = capi.sqlite3_file.structInfo.sizeof;
  vfs.$mxPathname = 1024;
  installer.installVfs({
    vfs: {
      struct: vfs,
      name,
      methods: {
        xOpen(_pVfs: number, zName: number, pFile: number, flags: number, pOutFlags: number) {
          try {
            if (!(flags & capi.SQLITE_OPEN_MAIN_DB)) return capi.SQLITE_CANTOPEN;
            const path = wasm.cstrToJs(zName) ?? '';
            open.set(Number(pFile), { path, size: files.size(path) });
            const file = new capi.sqlite3_file(pFile);
            file.$pMethods = io.pointer;
            file.dispose();
            wasm.poke32(pOutFlags, capi.SQLITE_OPEN_READONLY);
            return 0;
          } catch {
            return capi.SQLITE_CANTOPEN;
          }
        },
        // Immutable catalogs have no journal or WAL beside them.
        xAccess(_pVfs: number, _zName: number, _flags: number, pOut: number) {
          wasm.poke32(pOut, 0);
          return 0;
        },
        xDelete: () => 0,
        xFullPathname(_pVfs: number, zName: number, nOut: number, pOut: number) {
          return wasm.cstrncpy(pOut, zName, nOut) < nOut ? 0 : capi.SQLITE_CANTOPEN;
        },
        xGetLastError: () => 0,
      },
    },
  });
}
