import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { type Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  ChatModelIdentitySchema,
  ChatModelManifestSchema,
  ChatModelVersionManifestSchema,
  type GezmodelBundleManifest,
  GezmodelBundleManifestSchema,
  type GezmodelEngine,
  type GezmodelFile,
  type GezmodelImportProgress,
  type GezmodelImportReview,
  GezmodelImportReviewSchema,
} from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import * as yauzl from 'yauzl';
import * as yazl from 'yazl';
import { safeJoin } from '../fs/safe-paths.js';
import type { LlamaCppModelManager } from '../providers/llama-cpp/models.js';
import type { MlxModelManager } from '../providers/mlx/models.js';
import { type ModelBundleSource, safeBundleModelPath } from './bundle-storage.js';
import { MODEL_HASH_READ_BUFFER_BYTES } from './storage-roots.js';

const MAX_ARCHIVE_BYTES = 2 * 1024 ** 4; // 2 TiB compressed upload ceiling.
const MAX_ENTRIES = 16_384;
const MAX_TOTAL_UNCOMPRESSED_BYTES = 2 * 1024 ** 4;
const MAX_ENTRY_UNCOMPRESSED_BYTES = 2 * 1024 ** 4;
const MAX_COMPRESSION_RATIO = 200;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const IMPORT_TTL_MS = 24 * 60 * 60_000;
const SCAN_YIELD_BYTES = 16 * 1024 * 1024;
const BLOCKED_EXTENSIONS = new Set([
  '.app',
  '.bat',
  '.bin',
  '.cmd',
  '.com',
  '.cpl',
  '.dll',
  '.dylib',
  '.exe',
  '.js',
  '.mjs',
  '.cjs',
  '.msi',
  '.ps1',
  '.py',
  '.scr',
  '.sh',
  '.so',
  '.vbs',
]);

interface BundleOwner {
  getModelBundleSource(id: string): Promise<ModelBundleSource>;
  resolveModel(id: string): Promise<unknown | null>;
  importModelBundle(opts: {
    id: string;
    stagedModelDir: string;
    installedManifest: Record<string, unknown>;
    replace: boolean;
  }): Promise<void>;
}

interface ScannedEntry {
  entry: yauzl.Entry;
  name: string;
}

interface StoredReview extends GezmodelImportReview {
  stagedAt: string;
}

export interface GezmodelExport {
  stream: NodeJS.ReadableStream;
  filename: string;
  manifest: GezmodelBundleManifest;
}

export interface GezmodelScanOptions {
  importId?: string;
  bytesTotal?: number;
  signal?: AbortSignal;
  onProgress?: (progress: GezmodelImportProgress) => void;
  onUploadComplete?: () => void;
}

export class GezmodelManager {
  private readonly importsRoot: string;
  private readonly catalog: CatalogService;
  private readonly owners: Record<GezmodelEngine, BundleOwner>;

  constructor(opts: {
    home: string;
    catalog: CatalogService;
    llamaCpp: LlamaCppModelManager;
    mlx: MlxModelManager;
    ds4: LlamaCppModelManager;
  }) {
    this.importsRoot = join(opts.home, '.transactions', 'gezmodel-imports');
    this.catalog = opts.catalog;
    this.owners = {
      'llama-cpp': opts.llamaCpp,
      mlx: opts.mlx,
      ds4: opts.ds4,
    };
  }

  /** Hash model files, buffer the small manifests, then stream the ZIP payload. */
  async export(engine: GezmodelEngine, id: string): Promise<GezmodelExport> {
    const owner = this.owner(engine);
    const source = await owner.getModelBundleSource(id);
    const detail =
      (source.catalogVersion
        ? await this.catalog.get('chat-model', id, undefined, source.catalogVersion)
        : null) ?? (await this.catalog.get('chat-model', id));
    if (!detail || detail.manifest.kind !== 'chat-model') {
      throw new Error(`catalog manifest for model "${id}" is unavailable`);
    }

    const buffers = new Map<string, Buffer>();
    buffers.set(
      'manifests/installed.json',
      Buffer.from(`${JSON.stringify(source.installedManifest, null, 2)}\n`, 'utf8'),
    );
    buffers.set(
      'manifests/catalog.json',
      Buffer.from(`${JSON.stringify(detail.manifest, null, 2)}\n`, 'utf8'),
    );

    // Preserve Gezel's exact identity + selected-version manifest files when
    // the catalog source exposes them. The resolved snapshot above remains the
    // authoritative import/review shape when a synthetic source has no files.
    const wantedCatalogRels = new Set([
      'manifest.json',
      `versions/${source.catalogVersion ?? detail.manifest.version}/manifest.json`,
    ]);
    const catalogRels = await this.catalog.listItemFiles('chat-model', id, detail.sourceId);
    for (const rel of catalogRels) {
      if (!wantedCatalogRels.has(rel)) continue;
      const content = await this.catalog.readItemFile('chat-model', id, rel, detail.sourceId);
      if (!content) continue;
      buffers.set(`catalog/chat-models/${id.slice(0, 2).toLowerCase()}/${id}/${rel}`, content);
    }

    const files: GezmodelFile[] = [];
    for (const rel of source.modelFiles) {
      const full = safeBundleModelPath(source.modelDir, rel);
      const info = await stat(full);
      if (!info.isFile()) throw new Error(`model entry is not a regular file: ${rel}`);
      files.push({
        path: `model/${rel}`,
        sizeBytes: info.size,
        sha256: await hashFile(full),
        role: 'model',
      });
    }
    for (const [path, content] of buffers) {
      files.push({
        path,
        sizeBytes: content.byteLength,
        sha256: createHash('sha256').update(content).digest('hex'),
        role:
          path === 'manifests/installed.json'
            ? 'installed-manifest'
            : path === 'manifests/catalog.json'
              ? 'catalog-manifest'
              : 'catalog-file',
      });
    }
    files.sort((a, b) => a.path.localeCompare(b.path));

    const modelBytes = files
      .filter((file) => file.role === 'model')
      .reduce((sum, file) => sum + file.sizeBytes, 0);
    const manifest: GezmodelBundleManifest = {
      schemaVersion: 1,
      kind: 'gezel-model',
      id,
      name: source.name,
      engine,
      createdAt: new Date().toISOString(),
      createdBy: 'gezel',
      catalogVersion: source.catalogVersion ?? detail.manifest.version,
      approxSizeBytes: modelBytes,
      ...(detail.manifest.license
        ? {
            license: {
              name: detail.manifest.license,
              ...(detail.manifest.licenseShortName
                ? { shortName: detail.manifest.licenseShortName }
                : {}),
              ...(detail.manifest.licenseClass ? { class: detail.manifest.licenseClass } : {}),
              ...(detail.manifest.licenseUrl ? { url: detail.manifest.licenseUrl } : {}),
            },
          }
        : {}),
      files,
    };
    GezmodelBundleManifestSchema.parse(manifest);

    const zip = new yazl.ZipFile();
    zip.addBuffer(Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), 'manifest.json');
    for (const file of files) {
      if (file.role === 'model') {
        zip.addFile(
          safeBundleModelPath(source.modelDir, file.path.slice('model/'.length)),
          file.path,
          {
            compress: false,
          },
        );
      } else {
        const content = buffers.get(file.path);
        if (!content) throw new Error(`missing prepared bundle entry: ${file.path}`);
        zip.addBuffer(content, file.path, { compress: true });
      }
    }
    zip.end({
      forceZip64Format: files.some((file) => file.sizeBytes >= 0xffff_ffff),
      comment: '',
    });
    return {
      stream: zip.outputStream,
      filename: `${portableFilename(id)}.gezmodel`,
      manifest,
    };
  }

  /**
   * Stream an uploaded archive into private transaction staging, inspect its
   * central directory, extract through hash-verifying streams, then return a
   * review token. No engine directory is touched here.
   */
  async scanUpload(input: Readable, opts: GezmodelScanOptions = {}): Promise<GezmodelImportReview> {
    await mkdir(this.importsRoot, { recursive: true });
    await this.cleanupExpired();
    const importId = opts.importId ?? randomUUID();
    const stage = this.stagePath(importId);
    const archivePath = join(stage, 'bundle.gezmodel');
    await mkdir(stage, { recursive: true });
    try {
      opts.signal?.throwIfAborted();
      let uploaded = 0;
      opts.onProgress?.({
        phase: 'receiving',
        bytesCompleted: 0,
        ...(opts.bytesTotal === undefined ? {} : { bytesTotal: opts.bytesTotal }),
      });
      let uploadedSinceYield = 0;
      const limiter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          uploaded += chunk.byteLength;
          if (uploaded > MAX_ARCHIVE_BYTES) {
            callback(new Error('model bundle exceeds the 2 TiB archive limit'));
            return;
          }
          opts.onProgress?.({
            phase: 'receiving',
            bytesCompleted: uploaded,
            ...(opts.bytesTotal === undefined ? {} : { bytesTotal: opts.bytesTotal }),
          });
          uploadedSinceYield += chunk.byteLength;
          if (uploadedSinceYield >= SCAN_YIELD_BYTES) {
            uploadedSinceYield = 0;
            setImmediate(callback, null, chunk);
            return;
          }
          callback(null, chunk);
        },
      });
      const archiveWriter = createWriteStream(archivePath, { flags: 'wx' });
      if (opts.signal) await pipeline(input, limiter, archiveWriter, { signal: opts.signal });
      else await pipeline(input, limiter, archiveWriter);
      opts.onUploadComplete?.();

      opts.signal?.throwIfAborted();
      opts.onProgress?.({ phase: 'inspecting' });
      const entries = await inspectArchive(archivePath, opts.signal);
      const root = entries.get('manifest.json');
      if (!root) throw new Error('not a .gezmodel bundle: root manifest.json is missing');
      if (root.entry.uncompressedSize > MAX_MANIFEST_BYTES) {
        throw new Error('bundle manifest is too large');
      }
      const manifest = GezmodelBundleManifestSchema.parse(
        JSON.parse(
          (await readZipEntry(archivePath, root.entry, MAX_MANIFEST_BYTES, opts.signal)).toString(
            'utf8',
          ),
        ),
      );
      validateEntryTable(manifest, entries);

      const extractedRoot = join(stage, 'extracted');
      await mkdir(extractedRoot, { recursive: true });
      const bytesTotal = manifest.files.reduce((sum, file) => sum + file.sizeBytes, 0);
      let bytesCompleted = 0;
      opts.onProgress?.({ phase: 'verifying', bytesCompleted, bytesTotal });
      await extractVerified(archivePath, entries, manifest, extractedRoot, opts.signal, (bytes) => {
        bytesCompleted += bytes;
        opts.onProgress?.({ phase: 'verifying', bytesCompleted, bytesTotal });
      });
      opts.signal?.throwIfAborted();
      opts.onProgress?.({ phase: 'validating' });
      const installedManifest = await readJsonObject(
        join(extractedRoot, 'manifests', 'installed.json'),
      );
      const catalogManifest = ChatModelManifestSchema.parse(
        JSON.parse(await readFile(join(extractedRoot, 'manifests', 'catalog.json'), 'utf8')),
      );
      if (
        catalogManifest.kind !== 'chat-model' ||
        catalogManifest.id !== manifest.id ||
        catalogManifest.name !== manifest.name
      ) {
        throw new Error('catalog manifest identity does not match the bundle manifest');
      }
      if (installedManifest.id !== manifest.id) {
        throw new Error('installed manifest identity does not match the bundle manifest');
      }
      await validateRawCatalogFiles(extractedRoot, manifest);
      opts.signal?.throwIfAborted();
      await validateModelPayload(join(extractedRoot, 'model'), manifest);
      opts.signal?.throwIfAborted();
      await rm(archivePath, { force: true });

      const alreadyInstalled = Boolean(await this.owner(manifest.engine).resolveModel(manifest.id));
      const warnings: string[] = [];
      if (!manifest.license) warnings.push('No model license was included in this bundle.');
      if (manifest.engine === 'mlx' && process.platform !== 'darwin') {
        warnings.push('MLX models can only run on Apple Silicon Macs.');
      }
      const review: StoredReview = {
        importId,
        manifest,
        alreadyInstalled,
        warnings,
        stagedAt: new Date().toISOString(),
      };
      await writeFile(join(stage, 'review.json'), `${JSON.stringify(review, null, 2)}\n`, 'utf8');
      return GezmodelImportReviewSchema.parse(review);
    } catch (err) {
      await rm(stage, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
  }

  /** Re-verify staged bytes after the review pause, then atomically install. */
  async confirmImport(
    importId: string,
    replace: boolean,
  ): Promise<{ engine: GezmodelEngine; id: string }> {
    const { stage, review } = await this.loadReview(importId);
    const owner = this.owner(review.manifest.engine);
    const alreadyInstalled = Boolean(await owner.resolveModel(review.manifest.id));
    if (alreadyInstalled && !replace)
      throw new Error(`model "${review.manifest.id}" already exists locally`);

    const extractedRoot = join(stage, 'extracted');
    await verifyExtractedFiles(extractedRoot, review.manifest);
    const installedManifest = await readJsonObject(
      join(extractedRoot, 'manifests', 'installed.json'),
    );
    await owner.importModelBundle({
      id: review.manifest.id,
      stagedModelDir: join(extractedRoot, 'model'),
      installedManifest,
      replace,
    });
    await rm(stage, { recursive: true, force: true }).catch(() => {});
    return { engine: review.manifest.engine, id: review.manifest.id };
  }

  async cancelImport(importId: string): Promise<void> {
    const stage = this.stagePath(importId);
    await rm(stage, { recursive: true, force: true });
  }

  private owner(engine: GezmodelEngine): BundleOwner {
    const owner = this.owners[engine];
    if (!owner) throw new Error(`unsupported model bundle engine: ${engine}`);
    return owner;
  }

  private stagePath(importId: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(importId)) {
      throw new Error('invalid model import id');
    }
    const stage = safeJoin(this.importsRoot, importId);
    if (!stage) throw new Error('invalid model import path');
    return stage;
  }

  private async loadReview(importId: string): Promise<{ stage: string; review: StoredReview }> {
    const stage = this.stagePath(importId);
    const raw = JSON.parse(await readFile(join(stage, 'review.json'), 'utf8')) as StoredReview;
    const parsed = GezmodelImportReviewSchema.parse(raw);
    const stagedAt = typeof raw.stagedAt === 'string' ? Date.parse(raw.stagedAt) : Number.NaN;
    if (!Number.isFinite(stagedAt) || Date.now() - stagedAt > IMPORT_TTL_MS) {
      await rm(stage, { recursive: true, force: true }).catch(() => {});
      throw new Error('model import review expired; scan the bundle again');
    }
    return { stage, review: { ...parsed, stagedAt: raw.stagedAt } };
  }

  private async cleanupExpired(): Promise<void> {
    let ids: string[] = [];
    try {
      ids = await readdir(this.importsRoot);
    } catch {
      return;
    }
    await Promise.all(
      ids.map(async (id) => {
        const path = safeJoin(this.importsRoot, id);
        if (!path) return;
        try {
          const info = await stat(path);
          if (Date.now() - info.mtimeMs > IMPORT_TTL_MS) {
            await rm(path, { recursive: true, force: true });
          }
        } catch {
          // Best-effort cleanup; the active scan/confirm path remains authoritative.
        }
      }),
    );
  }
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  // Big read buffer so hashing a multi-GB bundle doesn't starve inside the
  // busy daemon event loop. See MODEL_HASH_READ_BUFFER_BYTES.
  const stream = createReadStream(path, { highWaterMark: MODEL_HASH_READ_BUFFER_BYTES });
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function portableFilename(id: string): string {
  return id.replace(/[^a-z0-9._-]+/gi, '-').replace(/^[.-]+/, '') || 'model';
}

function inspectArchive(path: string, signal?: AbortSignal): Promise<Map<string, ScannedEntry>> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    yauzl.open(
      path,
      { lazyEntries: true, decodeStrings: true, validateEntrySizes: true },
      (err, zip) => {
        if (err || !zip) {
          reject(new Error(`not a readable ZIP archive: ${err?.message ?? 'unknown error'}`));
          return;
        }
        const entries = new Map<string, ScannedEntry>();
        const portableNames = new Set<string>();
        let totalCompressed = 0;
        let totalUncompressed = 0;
        let count = 0;
        let settled = false;
        const cleanup = () => signal?.removeEventListener('abort', abort);
        const fail = (error: Error) => {
          if (settled) return;
          settled = true;
          cleanup();
          zip.close();
          reject(error);
        };
        const abort = () => fail(abortReason(signal));
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) return abort();
        zip.on('error', fail);
        zip.on('entry', (entry) => {
          try {
            signal?.throwIfAborted();
            count += 1;
            if (count > MAX_ENTRIES)
              throw new Error(`archive has more than ${MAX_ENTRIES} entries`);
            const name = entry.fileName;
            if (name.endsWith('/')) throw new Error(`directory entries are not allowed: ${name}`);
            if (!isSafeArchivePath(name)) throw new Error(`unsafe archive path: ${name}`);
            const portable = name.toLowerCase();
            if (portableNames.has(portable)) throw new Error(`duplicate archive path: ${name}`);
            portableNames.add(portable);
            if ((entry.generalPurposeBitFlag & 0x1) !== 0) {
              throw new Error(`encrypted archive entries are not allowed: ${name}`);
            }
            const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
            if ((unixMode & 0o170000) === 0o120000) {
              throw new Error(`symbolic links are not allowed: ${name}`);
            }
            if (entry.uncompressedSize > MAX_ENTRY_UNCOMPRESSED_BYTES) {
              throw new Error(`archive entry is larger than the 2 TiB limit: ${name}`);
            }
            totalCompressed += entry.compressedSize;
            totalUncompressed += entry.uncompressedSize;
            if (totalUncompressed > MAX_TOTAL_UNCOMPRESSED_BYTES) {
              throw new Error('archive expands beyond the 2 TiB total limit');
            }
            entries.set(name, { entry, name });
            zip.readEntry();
          } catch (error) {
            fail(error instanceof Error ? error : new Error(String(error)));
          }
        });
        zip.on('end', () => {
          if (settled) return;
          if (
            totalCompressed > 1024 &&
            totalUncompressed / Math.max(totalCompressed, 1) > MAX_COMPRESSION_RATIO
          ) {
            settled = true;
            cleanup();
            reject(new Error(`archive compression ratio exceeds ${MAX_COMPRESSION_RATIO}:1`));
            return;
          }
          settled = true;
          cleanup();
          resolve(entries);
        });
        zip.readEntry();
      },
    );
  });
}

function readZipEntry(
  path: string,
  wanted: yauzl.Entry,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    yauzl.open(
      path,
      { lazyEntries: true, decodeStrings: true, validateEntrySizes: true },
      (err, zip) => {
        if (err || !zip) return reject(err ?? new Error('could not open ZIP'));
        let settled = false;
        const cleanup = () => signal?.removeEventListener('abort', abort);
        const fail = (error: unknown) => {
          if (settled) return;
          settled = true;
          cleanup();
          zip.close();
          reject(error instanceof Error ? error : new Error(String(error)));
        };
        const abort = () => fail(abortReason(signal));
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) return abort();
        zip.on('error', fail);
        zip.on('entry', (entry) => {
          if (signal?.aborted) return fail(abortReason(signal));
          if (entry.fileName !== wanted.fileName) {
            zip.readEntry();
            return;
          }
          zip.openReadStream(entry, (streamErr, stream) => {
            if (streamErr || !stream)
              return fail(streamErr ?? new Error('could not read ZIP entry'));
            const chunks: Buffer[] = [];
            let bytes = 0;
            stream.on('data', (chunk: Buffer) => {
              bytes += chunk.byteLength;
              if (bytes > maxBytes) stream.destroy(new Error('ZIP entry exceeds read limit'));
              else chunks.push(chunk);
            });
            stream.on('error', fail);
            stream.on('end', () => {
              if (settled) return;
              settled = true;
              cleanup();
              zip.close();
              resolve(Buffer.concat(chunks));
            });
          });
        });
        zip.on('end', () => fail(new Error(`ZIP entry is missing: ${wanted.fileName}`)));
        zip.readEntry();
      },
    );
  });
}

function validateEntryTable(
  manifest: GezmodelBundleManifest,
  entries: Map<string, ScannedEntry>,
): void {
  const declared = new Map(manifest.files.map((file) => [file.path, file]));
  if (declared.size !== manifest.files.length)
    throw new Error('bundle manifest has duplicate files');
  if (!manifest.files.some((file) => file.role === 'model')) {
    throw new Error('bundle manifest contains no model files');
  }
  const installed = manifest.files.filter((file) => file.role === 'installed-manifest');
  const catalog = manifest.files.filter((file) => file.role === 'catalog-manifest');
  if (installed.length !== 1 || installed[0]?.path !== 'manifests/installed.json') {
    throw new Error('bundle must contain exactly one manifests/installed.json');
  }
  if (catalog.length !== 1 || catalog[0]?.path !== 'manifests/catalog.json') {
    throw new Error('bundle must contain exactly one manifests/catalog.json');
  }
  const expectedBytes = manifest.files
    .filter((file) => file.role === 'model')
    .reduce((sum, file) => sum + file.sizeBytes, 0);
  if (expectedBytes !== manifest.approxSizeBytes) {
    throw new Error('bundle model size does not match its manifest');
  }
  for (const file of manifest.files) {
    if (!pathMatchesRole(file)) throw new Error(`bundle role/path mismatch: ${file.path}`);
    if (BLOCKED_EXTENSIONS.has(extname(file.path).toLowerCase())) {
      throw new Error(`executable or script content is not allowed: ${file.path}`);
    }
    const actual = entries.get(file.path)?.entry;
    if (!actual) throw new Error(`bundle is missing declared file: ${file.path}`);
    if (actual.uncompressedSize !== file.sizeBytes) {
      throw new Error(`size mismatch for ${file.path}`);
    }
  }
  for (const name of entries.keys()) {
    if (name !== 'manifest.json' && !declared.has(name)) {
      throw new Error(`bundle contains an undeclared file: ${name}`);
    }
  }
}

function pathMatchesRole(file: GezmodelFile): boolean {
  if (file.role === 'model') return file.path.startsWith('model/');
  if (file.role === 'installed-manifest') return file.path === 'manifests/installed.json';
  if (file.role === 'catalog-manifest') return file.path === 'manifests/catalog.json';
  return file.path.startsWith('catalog/chat-models/');
}

async function extractVerified(
  archivePath: string,
  entries: Map<string, ScannedEntry>,
  manifest: GezmodelBundleManifest,
  extractedRoot: string,
  signal?: AbortSignal,
  onBytes?: (bytes: number) => void,
): Promise<void> {
  for (const file of manifest.files) {
    signal?.throwIfAborted();
    const scanned = entries.get(file.path);
    if (!scanned) throw new Error(`missing ZIP entry: ${file.path}`);
    const dest = safeJoin(extractedRoot, file.path);
    if (!dest) throw new Error(`unsafe extraction path: ${file.path}`);
    await mkdir(dirname(dest), { recursive: true });
    await extractOne(archivePath, scanned.entry, dest, file, signal, onBytes);
  }
}

function extractOne(
  archivePath: string,
  wanted: yauzl.Entry,
  dest: string,
  expected: GezmodelFile,
  signal?: AbortSignal,
  onBytes?: (bytes: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    yauzl.open(
      archivePath,
      { lazyEntries: true, decodeStrings: true, validateEntrySizes: true },
      (err, zip) => {
        if (err || !zip) return reject(err ?? new Error('could not open ZIP'));
        let settled = false;
        const cleanup = () => signal?.removeEventListener('abort', abort);
        const fail = (error: unknown) => {
          if (settled) return;
          settled = true;
          cleanup();
          zip.close();
          reject(error instanceof Error ? error : new Error(String(error)));
        };
        const abort = () => fail(abortReason(signal));
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) return abort();
        zip.on('error', fail);
        zip.on('entry', (entry) => {
          if (signal?.aborted) return fail(abortReason(signal));
          if (entry.fileName !== wanted.fileName) {
            zip.readEntry();
            return;
          }
          zip.openReadStream(entry, (streamErr, stream) => {
            if (streamErr || !stream)
              return fail(streamErr ?? new Error('could not read ZIP entry'));
            const hash = createHash('sha256');
            let bytes = 0;
            let bytesSinceYield = 0;
            const verifier = new Transform({
              transform(chunk: Buffer, _encoding, callback) {
                bytes += chunk.byteLength;
                bytesSinceYield += chunk.byteLength;
                hash.update(chunk);
                onBytes?.(chunk.byteLength);
                if (bytesSinceYield >= SCAN_YIELD_BYTES) {
                  bytesSinceYield = 0;
                  setImmediate(callback, null, chunk);
                  return;
                }
                callback(null, chunk);
              },
            });
            const extraction = signal
              ? pipeline(stream, verifier, createWriteStream(dest, { flags: 'wx' }), { signal })
              : pipeline(stream, verifier, createWriteStream(dest, { flags: 'wx' }));
            extraction
              .then(() => {
                if (bytes !== expected.sizeBytes || hash.digest('hex') !== expected.sha256) {
                  throw new Error(`checksum verification failed for ${expected.path}`);
                }
                if (settled) return;
                settled = true;
                cleanup();
                zip.close();
                resolve();
              })
              .catch(fail);
          });
        });
        zip.on('end', () => fail(new Error(`ZIP entry is missing: ${wanted.fileName}`)));
        zip.readEntry();
      },
    );
  });
}

function abortReason(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error('model bundle scan canceled');
  error.name = 'AbortError';
  return error;
}

async function verifyExtractedFiles(root: string, manifest: GezmodelBundleManifest): Promise<void> {
  for (const file of manifest.files) {
    const path = safeJoin(root, file.path);
    if (!path) throw new Error(`unsafe staged path: ${file.path}`);
    const info = await stat(path);
    if (!info.isFile() || info.size !== file.sizeBytes || (await hashFile(path)) !== file.sha256) {
      throw new Error(`staged model file changed after scanning: ${file.path}`);
    }
  }
}

async function validateModelPayload(
  modelRoot: string,
  manifest: GezmodelBundleManifest,
): Promise<void> {
  const modelFiles = manifest.files.filter((file) => file.role === 'model');
  if (manifest.engine === 'llama-cpp' || manifest.engine === 'ds4') {
    for (const file of modelFiles) {
      if (!file.path.toLowerCase().endsWith('.gguf')) {
        throw new Error(`${manifest.engine} bundles may contain only GGUF model files`);
      }
      const path = safeJoin(modelRoot, file.path.slice('model/'.length));
      if (!path) throw new Error(`unsafe model path: ${file.path}`);
      const handle = await open(path, 'r');
      try {
        const magic = Buffer.alloc(4);
        await handle.read(magic, 0, 4, 0);
        if (magic.toString('ascii') !== 'GGUF')
          throw new Error(`invalid GGUF header: ${file.path}`);
      } finally {
        await handle.close();
      }
    }
    return;
  }

  const weights = modelFiles.filter((file) => file.path.toLowerCase().endsWith('.safetensors'));
  if (weights.length === 0) throw new Error('MLX bundle has no safetensors weights');
  if (!modelFiles.some((file) => file.path === 'model/config.json')) {
    throw new Error('MLX bundle has no config.json');
  }
  for (const file of weights) {
    const path = safeJoin(modelRoot, file.path.slice('model/'.length));
    if (!path) throw new Error(`unsafe model path: ${file.path}`);
    await validateSafetensorsHeader(path, file.sizeBytes);
  }
  JSON.parse(await readFile(join(modelRoot, 'config.json'), 'utf8'));
}

async function validateSafetensorsHeader(path: string, sizeBytes: number): Promise<void> {
  const handle = await open(path, 'r');
  try {
    const prefix = Buffer.alloc(8);
    const read = await handle.read(prefix, 0, 8, 0);
    if (read.bytesRead !== 8) throw new Error(`truncated safetensors file: ${basename(path)}`);
    const headerBytes = Number(prefix.readBigUInt64LE(0));
    if (!Number.isSafeInteger(headerBytes) || headerBytes <= 1 || headerBytes > 16 * 1024 * 1024) {
      throw new Error(`invalid safetensors header length: ${basename(path)}`);
    }
    if (headerBytes + 8 > sizeBytes)
      throw new Error(`truncated safetensors header: ${basename(path)}`);
    const header = Buffer.alloc(headerBytes);
    await handle.read(header, 0, headerBytes, 8);
    const parsed = JSON.parse(header.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`invalid safetensors metadata: ${basename(path)}`);
    }
  } finally {
    await handle.close();
  }
}

async function validateRawCatalogFiles(
  root: string,
  manifest: GezmodelBundleManifest,
): Promise<void> {
  for (const file of manifest.files.filter((entry) => entry.role === 'catalog-file')) {
    const full = safeJoin(root, file.path);
    if (!full) throw new Error(`unsafe catalog manifest path: ${file.path}`);
    const json = JSON.parse(await readFile(full, 'utf8'));
    if (/\/versions\/[^/]+\/manifest\.json$/.test(file.path)) {
      const version = ChatModelVersionManifestSchema.parse(json);
      if (manifest.catalogVersion && version.version !== manifest.catalogVersion) {
        throw new Error('catalog version manifest does not match the bundle version');
      }
    } else if (file.path.endsWith('/manifest.json')) {
      const identity = ChatModelIdentitySchema.parse(json);
      if (identity.id !== manifest.id) throw new Error('catalog identity manifest id mismatch');
    }
  }
}

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  const parsed = JSON.parse(await readFile(path, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${basename(path)} must contain a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function isSafeArchivePath(path: string): boolean {
  if (
    path.length === 0 ||
    path.length > 1024 ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.startsWith('/')
  ) {
    return false;
  }
  const scratch = safeJoin('gezel-bundle-root', path);
  return scratch !== null;
}
