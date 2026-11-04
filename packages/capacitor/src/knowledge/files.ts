/// <reference lib="dom" />
import { type ArchiveEntry, readArchiveIndex } from './zip.js';

/** Synchronous reads of the catalog store, as the worker's SQLite needs them. */
export interface RawFiles {
  size(path: string): number;
  read(path: string, offset: number, length: number): Uint8Array;
}

export class FileMissingError extends Error {
  readonly code = 'ENOENT';
  constructor(path: string) {
    super(`ENOENT: no such file, ${path}`);
  }
}

/**
 * Range reads of the store over HTTP: `/_gezel_knowledge` on Android (served
 * by KnowledgeFiles), Capacitor's `_capacitor_file_` URL on iOS. Synchronous
 * XHR, which only a Web Worker may use, because SQLite reads synchronously.
 */
export function httpFiles(baseUrl: string): RawFiles {
  const sizes = new Map<string, number>();
  const url = (path: string) => baseUrl + path.split('/').map(encodeURIComponent).join('/');
  const request = (path: string, start: number, end: number) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url(path), false);
    xhr.responseType = 'arraybuffer';
    xhr.setRequestHeader('Range', `bytes=${start}-${end}`);
    xhr.send();
    if (xhr.status === 404) throw new FileMissingError(path);
    if (xhr.status !== 206) throw new Error(`Catalog read failed (HTTP ${xhr.status})`);
    const total = /\/(\d+)$/.exec(xhr.getResponseHeader('Content-Range') ?? '')?.[1];
    if (total) sizes.set(path, Number(total));
    return new Uint8Array(xhr.response as ArrayBuffer);
  };
  return {
    size(path) {
      if (!sizes.has(path)) request(path, 0, 0);
      return sizes.get(path) ?? 0;
    },
    read: (path, offset, length) =>
      length > 0 ? request(path, offset, offset + length - 1) : new Uint8Array(),
  };
}

/**
 * The files inside each `.gezk` archive, addressed as `<archive>.gezk/<entry>`:
 * a catalog's root directory is its archive, so the reader runs unchanged.
 */
export function archiveFiles(raw: RawFiles): RawFiles & { forget(archive: string): void } {
  const indexes = new Map<string, Map<string, ArchiveEntry>>();
  const locate = (path: string) => {
    const at = path.indexOf('.gezk/');
    if (at < 0) throw new FileMissingError(path);
    const archive = path.slice(0, at + 5);
    let index = indexes.get(archive);
    if (!index) {
      index = readArchiveIndex(
        (offset, length) => raw.read(archive, offset, length),
        raw.size(archive),
      );
      indexes.set(archive, index);
    }
    const entry = index.get(path.slice(at + 6));
    if (!entry) throw new FileMissingError(path);
    return { archive, entry };
  };
  return {
    size: (path) => locate(path).entry.size,
    read(path, offset, length) {
      const { archive, entry } = locate(path);
      const available = Math.max(0, Math.min(length, entry.size - offset));
      return available ? raw.read(archive, entry.offset + offset, available) : new Uint8Array();
    },
    forget: (archive) => void indexes.delete(archive),
  };
}
