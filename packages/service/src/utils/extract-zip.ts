import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { type Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as yauzl from 'yauzl';
import { safeJoin } from '../fs/safe-paths.js';

export interface ExtractZipOptions {
  signal?: AbortSignal;
  /** Called as bytes land on disk, against the archive's total unpacked size. */
  onProgress?: (bytesWritten: number, totalBytes: number) => void;
}

/**
 * Extract every entry of a zip archive into `destDir`, overwriting files that
 * are already there.
 *
 * Use this instead of `new AdmZip(path).extractAllTo(dir)` for anything large.
 * AdmZip reads the whole archive into memory, then inflates and writes every
 * entry synchronously. In embedded mode the daemon runs on Electron's main
 * thread, so extracting the 641 MB Windows CUDA engine (1.4 GB unpacked) that
 * way blocked it for ~18 s. A window brought back from behind another app
 * could not repaint and showed only its sage background, and the person quit
 * it mid-extraction (2026-10-11). Here each entry streams through yauzl's
 * inflate, so the event loop keeps turning.
 *
 * Every entry is checked before the first byte is written, so a bad archive
 * leaves nothing behind.
 */
export async function extractZip(
  zipPath: string,
  destDir: string,
  opts: ExtractZipOptions = {},
): Promise<void> {
  const { signal, onProgress } = opts;
  signal?.throwIfAborted();
  const zip = await openZip(zipPath);
  try {
    const entries = await readEntries(zip, destDir);
    const totalBytes = entries.reduce((sum, { entry }) => sum + entry.uncompressedSize, 0);
    let bytesWritten = 0;
    onProgress?.(0, totalBytes);
    for (const { entry, dest } of entries) {
      signal?.throwIfAborted();
      if (entry.fileName.endsWith('/')) {
        await mkdir(dest, { recursive: true });
        continue;
      }
      await mkdir(dirname(dest), { recursive: true });
      const input = await openEntryStream(zip, entry);
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytesWritten += chunk.length;
          onProgress?.(bytesWritten, totalBytes);
          callback(null, chunk);
        },
      });
      const output = createWriteStream(dest);
      if (signal) await pipeline(input, counter, output, { signal });
      else await pipeline(input, counter, output);
    }
  } finally {
    zip.close();
  }
}

function openZip(zipPath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(
      zipPath,
      { lazyEntries: true, autoClose: false, decodeStrings: true, validateEntrySizes: true },
      (err, zip) => {
        if (err || !zip) {
          reject(new Error(`not a readable ZIP archive: ${err?.message ?? 'unknown error'}`));
        } else {
          resolve(zip);
        }
      },
    );
  });
}

function readEntries(
  zip: yauzl.ZipFile,
  destDir: string,
): Promise<Array<{ entry: yauzl.Entry; dest: string }>> {
  return new Promise((resolve, reject) => {
    const entries: Array<{ entry: yauzl.Entry; dest: string }> = [];
    zip.on('error', reject);
    zip.on('end', () => resolve(entries));
    zip.on('entry', (entry: yauzl.Entry) => {
      const name = entry.fileName;
      const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
      if ((unixMode & 0o170000) === 0o120000) {
        reject(new Error(`symbolic links are not supported: ${name}`));
        return;
      }
      const dest = safeJoin(destDir, name);
      if (!dest) {
        reject(new Error(`unsafe archive path: ${name}`));
        return;
      }
      entries.push({ entry, dest });
      zip.readEntry();
    });
    zip.readEntry();
  });
}

function openEntryStream(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<Readable> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err || !stream) reject(err ?? new Error(`could not read ${entry.fileName}`));
      else resolve(stream);
    });
  });
}
