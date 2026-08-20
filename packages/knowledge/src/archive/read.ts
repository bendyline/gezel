/**
 * Streaming `.gezk` inspection + verified extraction — the gezmodel archive
 * discipline (packages/service/src/models/gezmodel.ts) applied to catalogs:
 * yauzl lazyEntries, per-entry safety rejection (traversal, absolute paths,
 * symlinks, encrypted entries, case-insensitive duplicates, directory
 * entries), manifest-declared-only extraction with BOTH-direction
 * reconciliation, and per-file SHA-256 verification against the manifest.
 * Never inflates the archive into memory.
 */

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { KnowledgeCatalogManifest } from '@bendyline/gezel';
import { KnowledgeCatalogManifestSchema } from '@bendyline/gezel';
import { MANIFEST_PATH } from '../format/constants.js';

const nodeRequire = createRequire(import.meta.url);

/** Catalog-specific limits — multi-GB archives are the point (draft §install). */
export const GEZK_ARCHIVE_LIMITS = {
  maxEntries: 16_384,
  maxManifestBytes: 64 * 1024 * 1024,
  maxEntryBytes: 8 * 1024 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024 * 1024,
  maxCompressionRatio: 400,
} as const;

export class GezkArchiveError extends Error {
  constructor(
    message: string,
    readonly reason:
      | 'unsafe-entry'
      | 'limits'
      | 'manifest'
      | 'undeclared-file'
      | 'missing-file'
      | 'hash-mismatch'
      | 'io',
  ) {
    super(message);
    this.name = 'GezkArchiveError';
  }
}

interface YauzlEntry {
  fileName: string;
  uncompressedSize: number;
  compressedSize: number;
  generalPurposeBitFlag: number;
  externalFileAttributes: number;
}

interface YauzlZip {
  readEntry(): void;
  openReadStream(
    entry: YauzlEntry,
    cb: (err: Error | null, stream?: NodeJS.ReadableStream) => void,
  ): void;
  close(): void;
  on(event: 'entry', cb: (entry: YauzlEntry) => void): void;
  on(event: 'end', cb: () => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
}

function openZip(archivePath: string): Promise<YauzlZip> {
  const yauzl = nodeRequire('yauzl') as {
    open(path: string, options: object, cb: (err: Error | null, zip?: YauzlZip) => void): void;
  };
  return new Promise((resolvePromise, reject) => {
    yauzl.open(
      archivePath,
      { lazyEntries: true, decodeStrings: true, validateEntrySizes: true },
      (err, zip) => {
        if (err || !zip) reject(err ?? new Error('yauzl returned no zip'));
        else resolvePromise(zip);
      },
    );
  });
}

function assertSafeEntry(entry: YauzlEntry, seenLower: Set<string>): void {
  const name = entry.fileName;
  if (name.endsWith('/')) throw new GezkArchiveError(`directory entry: ${name}`, 'unsafe-entry');
  if (
    name.includes('\\') ||
    name.startsWith('/') ||
    /(^|\/)\.\.(\/|$)/.test(name) ||
    /^[a-zA-Z]:/.test(name)
  ) {
    throw new GezkArchiveError(`unsafe path: ${name}`, 'unsafe-entry');
  }
  if ((entry.generalPurposeBitFlag & 0x1) !== 0) {
    throw new GezkArchiveError(`encrypted entry: ${name}`, 'unsafe-entry');
  }
  const unixMode = (entry.externalFileAttributes >>> 16) & 0o170000;
  if (unixMode === 0o120000) throw new GezkArchiveError(`symlink entry: ${name}`, 'unsafe-entry');
  const lower = name.toLowerCase();
  if (seenLower.has(lower)) {
    throw new GezkArchiveError(`duplicate entry (case-insensitive): ${name}`, 'unsafe-entry');
  }
  seenLower.add(lower);
  if (entry.uncompressedSize > GEZK_ARCHIVE_LIMITS.maxEntryBytes) {
    throw new GezkArchiveError(`entry exceeds size limit: ${name}`, 'limits');
  }
  if (
    entry.compressedSize > 0 &&
    entry.uncompressedSize / entry.compressedSize > GEZK_ARCHIVE_LIMITS.maxCompressionRatio
  ) {
    throw new GezkArchiveError(`suspicious compression ratio: ${name}`, 'limits');
  }
}

/** Walk the archive collecting the safety-checked entry table. */
async function inspectEntries(archivePath: string): Promise<Map<string, YauzlEntry>> {
  const zip = await openZip(archivePath);
  const entries = new Map<string, YauzlEntry>();
  const seenLower = new Set<string>();
  let total = 0;
  return new Promise((resolvePromise, reject) => {
    zip.on('entry', (entry) => {
      try {
        if (entries.size >= GEZK_ARCHIVE_LIMITS.maxEntries) {
          throw new GezkArchiveError('too many archive entries', 'limits');
        }
        assertSafeEntry(entry, seenLower);
        total += entry.uncompressedSize;
        if (total > GEZK_ARCHIVE_LIMITS.maxTotalBytes) {
          throw new GezkArchiveError('archive exceeds total size limit', 'limits');
        }
        entries.set(entry.fileName, entry);
        zip.readEntry();
      } catch (err) {
        zip.close();
        reject(err);
      }
    });
    zip.on('end', () => {
      zip.close();
      resolvePromise(entries);
    });
    zip.on('error', (err) => {
      zip.close();
      reject(new GezkArchiveError(`archive read failed: ${err.message}`, 'io'));
    });
    // lazyEntries: the walk only starts on the first explicit readEntry().
    zip.readEntry();
  });
}

/** Read + parse manifest.json without extracting anything else. */
export async function readGezkManifest(archivePath: string): Promise<KnowledgeCatalogManifest> {
  const zip = await openZip(archivePath);
  return new Promise((resolvePromise, reject) => {
    zip.on('entry', (entry) => {
      if (entry.fileName !== MANIFEST_PATH) {
        zip.readEntry();
        return;
      }
      if (entry.uncompressedSize > GEZK_ARCHIVE_LIMITS.maxManifestBytes) {
        zip.close();
        reject(new GezkArchiveError('manifest exceeds size limit', 'limits'));
        return;
      }
      zip.openReadStream(entry, (err, stream) => {
        if (err || !stream) {
          zip.close();
          reject(new GezkArchiveError(`manifest read failed: ${err?.message}`, 'io'));
          return;
        }
        const parts: Buffer[] = [];
        stream.on('data', (d: Buffer) => parts.push(d));
        stream.on('end', () => {
          zip.close();
          try {
            resolvePromise(
              KnowledgeCatalogManifestSchema.parse(
                JSON.parse(Buffer.concat(parts).toString('utf8')),
              ),
            );
          } catch (parseErr) {
            reject(
              new GezkArchiveError(
                `invalid manifest: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
                'manifest',
              ),
            );
          }
        });
        stream.on('error', (streamErr: Error) => {
          zip.close();
          reject(new GezkArchiveError(`manifest read failed: ${streamErr.message}`, 'io'));
        });
      });
    });
    zip.on('end', () => {
      zip.close();
      reject(new GezkArchiveError('archive has no manifest.json', 'manifest'));
    });
    zip.on('error', (err) => {
      zip.close();
      reject(new GezkArchiveError(`archive read failed: ${err.message}`, 'io'));
    });
    zip.readEntry();
  });
}

/**
 * Extract a verified catalog into `destDir`: entries and manifest.files must
 * reconcile in BOTH directions (an undeclared archive file and a declared-
 * but-missing file are equally fatal), and every extracted file's SHA-256
 * must match its declaration.
 */
export async function extractGezkVerified(
  archivePath: string,
  destDir: string,
): Promise<KnowledgeCatalogManifest> {
  const manifest = await readGezkManifest(archivePath);
  const entries = await inspectEntries(archivePath);

  const declared = new Map(manifest.files.map((f) => [f.path, f]));
  for (const path of entries.keys()) {
    if (path === MANIFEST_PATH) continue;
    if (!declared.has(path)) {
      throw new GezkArchiveError(`archive contains undeclared file: ${path}`, 'undeclared-file');
    }
  }
  for (const path of declared.keys()) {
    if (!entries.has(path)) {
      throw new GezkArchiveError(`archive is missing declared file: ${path}`, 'missing-file');
    }
  }

  const destRoot = normalize(resolve(destDir)) + sep;
  const zip = await openZip(archivePath);
  await new Promise<void>((resolvePromise, reject) => {
    const next = () => zip.readEntry();
    zip.on('entry', (entry) => {
      void (async () => {
        try {
          const target = resolve(destDir, entry.fileName);
          if (!normalize(target).startsWith(destRoot.slice(0, -1))) {
            throw new GezkArchiveError(
              `entry escapes destination: ${entry.fileName}`,
              'unsafe-entry',
            );
          }
          await mkdir(dirname(target), { recursive: true });
          await new Promise<void>((res, rej) => {
            zip.openReadStream(entry, (err, stream) => {
              if (err || !stream) {
                rej(new GezkArchiveError(`read failed: ${err?.message}`, 'io'));
                return;
              }
              pipeline(stream, createWriteStream(target)).then(res, rej);
            });
          });
          next();
        } catch (err) {
          zip.close();
          reject(
            err instanceof GezkArchiveError
              ? err
              : new GezkArchiveError(
                  `extraction failed for ${entry.fileName}: ${err instanceof Error ? err.message : String(err)}`,
                  'io',
                ),
          );
        }
      })();
    });
    zip.on('end', () => {
      zip.close();
      resolvePromise();
    });
    zip.on('error', (err) => {
      zip.close();
      reject(new GezkArchiveError(`archive read failed: ${err.message}`, 'io'));
    });
    zip.readEntry();
  });

  // Per-file hash verification against the manifest.
  for (const file of manifest.files) {
    const bytes = await readFile(join(destDir, file.path));
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== file.sha256) {
      throw new GezkArchiveError(
        `sha256 mismatch for ${file.path}: expected ${file.sha256}, got ${actual}`,
        'hash-mismatch',
      );
    }
    if (bytes.length !== file.sizeBytes) {
      throw new GezkArchiveError(
        `size mismatch for ${file.path}: expected ${file.sizeBytes}, got ${bytes.length}`,
        'hash-mismatch',
      );
    }
  }
  return manifest;
}
