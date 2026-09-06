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
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, normalize, relative, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { KnowledgeCatalogManifest } from '@bendyline/gezk';
import { GEZK_MANIFEST_KIND, KnowledgeCatalogManifestSchema } from '@bendyline/gezk';
import {
  GEZK_MIME_TYPE,
  GEZK_SUPPORTED_FORMAT_VERSIONS,
  MANIFEST_PATH,
  MIMETYPE_PATH,
  isSupportedFormatVersion,
} from '../format/constants.js';

const nodeRequire = createRequire(import.meta.url);

/** Catalog-specific limits — multi-GB archives are the point (draft §install). */
export const GEZK_ARCHIVE_LIMITS = {
  maxEntries: 16_384,
  maxManifestBytes: 16 * 1024 * 1024,
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
      | 'mimetype'
      | 'format-version'
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
  compressionMethod: number;
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
async function inspectEntries(
  archivePath: string,
): Promise<{ entries: Map<string, YauzlEntry>; totalUncompressedBytes: number }> {
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
      resolvePromise({ entries, totalUncompressedBytes: total });
    });
    zip.on('error', (err) => {
      zip.close();
      reject(new GezkArchiveError(`archive read failed: ${err.message}`, 'io'));
    });
    // lazyEntries: the walk only starts on the first explicit readEntry().
    zip.readEntry();
  });
}

function reconcileEntries(
  manifest: KnowledgeCatalogManifest,
  entries: Map<string, YauzlEntry>,
): void {
  const declared = new Map(manifest.files.map((file) => [file.path, file]));
  for (const path of entries.keys()) {
    if (path === MANIFEST_PATH || path === MIMETYPE_PATH) continue;
    if (!declared.has(path)) {
      throw new GezkArchiveError(`archive contains undeclared file: ${path}`, 'undeclared-file');
    }
  }
  for (const [path, file] of declared) {
    const entry = entries.get(path);
    if (!entry) {
      throw new GezkArchiveError(`archive is missing declared file: ${path}`, 'missing-file');
    }
    if (entry.uncompressedSize !== file.sizeBytes) {
      throw new GezkArchiveError(
        `declared size does not match ZIP metadata for ${path}: expected ${file.sizeBytes}, archive has ${entry.uncompressedSize}`,
        'hash-mismatch',
      );
    }
  }
}

export interface GezkArchiveInspection {
  manifest: KnowledgeCatalogManifest;
  entryCount: number;
  totalUncompressedBytes: number;
}

/** Safety-check and reconcile the complete central directory without extracting. */
export async function inspectGezkArchive(archivePath: string): Promise<GezkArchiveInspection> {
  const [manifest, inspected] = await Promise.all([
    readGezkManifest(archivePath),
    inspectEntries(archivePath),
  ]);
  reconcileEntries(manifest, inspected.entries);
  return {
    manifest,
    entryCount: inspected.entries.size,
    totalUncompressedBytes: inspected.totalUncompressedBytes,
  };
}

/** The container magic: a stored `mimetype` entry, first, with the exact media type. */
function assertMimetypeEntry(entry: YauzlEntry, position: number): void {
  if (position !== 0) {
    throw new GezkArchiveError('the mimetype entry must be the first archive entry', 'mimetype');
  }
  if (entry.compressionMethod !== 0 || entry.uncompressedSize !== GEZK_MIME_TYPE.length) {
    throw new GezkArchiveError('the mimetype entry must be stored, not compressed', 'mimetype');
  }
}

/** Reject a manifest from another format generation before schema parsing. */
function assertSupportedFormat(raw: unknown): void {
  const kind = (raw as { kind?: unknown } | null)?.kind;
  const version = (raw as { formatVersion?: unknown } | null)?.formatVersion;
  if (kind !== GEZK_MANIFEST_KIND || !isSupportedFormatVersion(version)) {
    throw new GezkArchiveError(
      `unsupported gezk format (kind ${String(kind)}, version ${String(version)}); this reader supports ${GEZK_MANIFEST_KIND} ${GEZK_SUPPORTED_FORMAT_VERSIONS.join(', ')} — catalogs built for another version need a matching reader`,
      'format-version',
    );
  }
}

function readEntryText(zip: YauzlZip, entry: YauzlEntry): Promise<string> {
  return new Promise((resolveText, rejectText) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err || !stream) {
        rejectText(new GezkArchiveError(`${entry.fileName} read failed: ${err?.message}`, 'io'));
        return;
      }
      const parts: Buffer[] = [];
      stream.on('data', (d: Buffer) => parts.push(d));
      stream.on('end', () => resolveText(Buffer.concat(parts).toString('utf8')));
      stream.on('error', (streamErr: Error) =>
        rejectText(
          new GezkArchiveError(`${entry.fileName} read failed: ${streamErr.message}`, 'io'),
        ),
      );
    });
  });
}

/** Read + parse manifest.json without extracting anything else. */
export async function readGezkManifest(archivePath: string): Promise<KnowledgeCatalogManifest> {
  const zip = await openZip(archivePath);
  return new Promise((resolvePromise, reject) => {
    let position = 0;
    let mimetypeSeen = false;
    const fail = (err: unknown) => {
      zip.close();
      reject(
        err instanceof GezkArchiveError
          ? err
          : new GezkArchiveError(err instanceof Error ? err.message : String(err), 'io'),
      );
    };
    zip.on('entry', (entry) => {
      const index = position++;
      if (entry.fileName === MIMETYPE_PATH) {
        try {
          assertMimetypeEntry(entry, index);
        } catch (err) {
          fail(err);
          return;
        }
        readEntryText(zip, entry).then((text) => {
          if (text !== GEZK_MIME_TYPE) {
            fail(
              new GezkArchiveError(
                `not a gezk archive (mimetype ${JSON.stringify(text)})`,
                'mimetype',
              ),
            );
            return;
          }
          mimetypeSeen = true;
          zip.readEntry();
        }, fail);
        return;
      }
      if (entry.fileName !== MANIFEST_PATH) {
        zip.readEntry();
        return;
      }
      if (!mimetypeSeen) {
        fail(
          new GezkArchiveError('archive does not start with the gezk mimetype entry', 'mimetype'),
        );
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
            const raw: unknown = JSON.parse(Buffer.concat(parts).toString('utf8'));
            assertSupportedFormat(raw);
            resolvePromise(KnowledgeCatalogManifestSchema.parse(raw));
          } catch (parseErr) {
            if (parseErr instanceof GezkArchiveError) {
              reject(parseErr);
              return;
            }
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
  const { entries } = await inspectEntries(archivePath);
  reconcileEntries(manifest, entries);
  const declared = new Map(manifest.files.map((file) => [file.path, file]));

  const destRoot = normalize(resolve(destDir));
  const zip = await openZip(archivePath);
  await new Promise<void>((resolvePromise, reject) => {
    const next = () => zip.readEntry();
    zip.on('entry', (entry) => {
      void (async () => {
        try {
          const target = resolve(destDir, entry.fileName);
          const targetRel = relative(destRoot, normalize(target));
          if (targetRel.startsWith('..') || isAbsolute(targetRel)) {
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
              const expected = declared.get(entry.fileName);
              if (!expected) {
                pipeline(stream, createWriteStream(target)).then(res, rej);
                return;
              }
              const hasher = createHash('sha256');
              let sizeBytes = 0;
              const verify = new Transform({
                transform(chunk: Buffer, _encoding, callback) {
                  sizeBytes += chunk.byteLength;
                  if (sizeBytes > expected.sizeBytes) {
                    callback(
                      new GezkArchiveError(
                        `size mismatch for ${entry.fileName}: expected ${expected.sizeBytes}, got more data`,
                        'hash-mismatch',
                      ),
                    );
                    return;
                  }
                  hasher.update(chunk);
                  callback(null, chunk);
                },
              });
              pipeline(stream, verify, createWriteStream(target))
                .then(() => {
                  const actual = hasher.digest('hex');
                  if (sizeBytes !== expected.sizeBytes) {
                    throw new GezkArchiveError(
                      `size mismatch for ${entry.fileName}: expected ${expected.sizeBytes}, got ${sizeBytes}`,
                      'hash-mismatch',
                    );
                  }
                  if (actual !== expected.sha256) {
                    throw new GezkArchiveError(
                      `sha256 mismatch for ${entry.fileName}: expected ${expected.sha256}, got ${actual}`,
                      'hash-mismatch',
                    );
                  }
                })
                .then(res, rej);
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
  return manifest;
}
