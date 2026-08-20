/**
 * Deterministic `.gezk` ZIP writer (gezk-format-v1.md §11): entries sorted
 * by path bytes, fixed timestamp (2000-01-01T00:00:00Z), mode 0644, UTF-8
 * names, ZIP64 as needed (yazl handles the transition). Compression is
 * zlib's default deflate — deterministic per toolchain, which is exactly the
 * determinism promise (the manifest records the toolchain fingerprint).
 */

import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { ZIP_FIXED_MTIME } from '../format/constants.js';

const nodeRequire = createRequire(import.meta.url);

export interface ArchiveEntry {
  /** Forward-slashed archive path. */
  path: string;
  /** Exactly one of absPath / content. */
  absPath?: string;
  content?: Buffer;
}

export async function writeGezkArchive(outputPath: string, entries: ArchiveEntry[]): Promise<void> {
  // CJS interop: yazl exposes ZipFile on module.exports.
  const yazl = nodeRequire('yazl') as {
    ZipFile: new () => {
      addFile(realPath: string, metadataPath: string, options?: object): void;
      addBuffer(buffer: Buffer, metadataPath: string, options?: object): void;
      end(): void;
      outputStream: NodeJS.ReadableStream;
    };
  };
  await mkdir(dirname(outputPath), { recursive: true });

  const zip = new yazl.ZipFile();
  const options = { mtime: ZIP_FIXED_MTIME, mode: 0o100644, compress: true };
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const entry of sorted) {
    if (entry.path.includes('\\') || entry.path.startsWith('/') || entry.path.includes('..')) {
      throw new Error(`unsafe archive path: ${entry.path}`);
    }
    if (entry.content) zip.addBuffer(entry.content, entry.path, options);
    else if (entry.absPath) zip.addFile(entry.absPath, entry.path, options);
    else throw new Error(`archive entry ${entry.path} has neither content nor absPath`);
  }

  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(outputPath);
    out.on('error', reject);
    out.on('close', () => resolve());
    zip.outputStream.on('error', reject);
    zip.outputStream.pipe(out);
    zip.end();
  });
}
