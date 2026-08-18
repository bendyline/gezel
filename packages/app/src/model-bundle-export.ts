import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { Readable as NodeReadable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { type GezmodelBundleManifest, GezmodelBundleManifestSchema } from '@bendyline/gezel';
import * as yauzl from 'yauzl';

const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const PROGRESS_REPORT_BYTES = 8 * 1024 * 1024;

export interface ModelBundleByteProgress {
  bytesCompleted: number;
  bytesTotal?: number;
}

/** The model payload is the useful progress denominator; ZIP bookkeeping adds a small tail. */
export function modelBytesFromResponse(response: Response): number | undefined {
  const raw = response.headers.get('x-gezel-model-bytes');
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const bytes = Number(raw);
  return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : undefined;
}

/**
 * Durably stream a service response into a brand-new partial file. The caller
 * publishes it only after verifyModelBundleArchive has accepted every entry.
 */
export async function writeModelBundleResponse(
  response: Response,
  path: string,
  onProgress: (progress: ModelBundleByteProgress) => void,
  signal?: AbortSignal,
): Promise<number> {
  throwIfAborted(signal);
  if (!response.body) throw new Error('service returned an empty export');
  const bytesTotal = modelBytesFromResponse(response);
  let bytesCompleted = 0;
  let bytesReported = 0;
  onProgress({ bytesCompleted, bytesTotal });
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytesCompleted += chunk.byteLength;
      if (bytesCompleted - bytesReported >= PROGRESS_REPORT_BYTES) {
        bytesReported = bytesCompleted;
        onProgress({ bytesCompleted, bytesTotal });
      }
      callback(null, chunk);
    },
  });
  await pipeline(
    NodeReadable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>),
    counter,
    createWriteStream(path, { flags: 'wx', flush: true }),
    { signal },
  );
  if (bytesCompleted !== bytesReported) onProgress({ bytesCompleted, bytesTotal });
  return bytesCompleted;
}

/**
 * Re-open the completed archive and SHA-256 every declared file against its
 * root manifest. This catches a short response, a corrupt ZIP tail, and any
 * payload that changed between the service's source hash pass and the save.
 */
export async function verifyModelBundleArchive(
  path: string,
  onProgress: (progress: Required<ModelBundleByteProgress>) => void,
  signal?: AbortSignal,
): Promise<GezmodelBundleManifest> {
  throwIfAborted(signal);
  const manifest = await readRootManifest(path, signal);
  const bytesTotal = manifest.files.reduce((sum, file) => sum + file.sizeBytes, 0);
  onProgress({ bytesCompleted: 0, bytesTotal });
  await verifyDeclaredEntries(
    path,
    manifest,
    (bytesCompleted) => {
      onProgress({ bytesCompleted, bytesTotal });
    },
    signal,
  );
  return manifest;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted', 'AbortError');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

function openArchive(path: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(
      path,
      { lazyEntries: true, decodeStrings: true, validateEntrySizes: true },
      (error, zip) => {
        if (error || !zip) {
          reject(
            new Error(`export is not a readable ZIP archive: ${error?.message ?? 'unknown error'}`),
          );
          return;
        }
        resolve(zip);
      },
    );
  });
}

async function readRootManifest(
  path: string,
  signal?: AbortSignal,
): Promise<GezmodelBundleManifest> {
  throwIfAborted(signal);
  const zip = await openArchive(path);
  if (signal?.aborted) {
    zip.close();
    throw abortError(signal);
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = () => signal?.removeEventListener('abort', onAbort);
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      finish();
      zip.close();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const onAbort = () => fail(abortError(signal as AbortSignal));
    signal?.addEventListener('abort', onAbort, { once: true });
    zip.on('error', fail);
    zip.on('entry', (entry) => {
      if (entry.fileName !== 'manifest.json') {
        zip.readEntry();
        return;
      }
      if (entry.uncompressedSize > MAX_MANIFEST_BYTES) {
        fail(new Error('export manifest is too large'));
        return;
      }
      zip.openReadStream(entry, (error, stream) => {
        if (error || !stream) {
          fail(error ?? new Error('could not read export manifest'));
          return;
        }
        void readSmallStream(stream, MAX_MANIFEST_BYTES, signal)
          .then((contents) => {
            const parsed = GezmodelBundleManifestSchema.parse(
              JSON.parse(contents.toString('utf8')),
            );
            if (settled) return;
            settled = true;
            finish();
            zip.close();
            resolve(parsed);
          })
          .catch(fail);
      });
    });
    zip.on('end', () => fail(new Error('export is missing its root manifest.json')));
    zip.readEntry();
  });
}

async function readSmallStream(
  stream: NodeReadable,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  const onAbort = () => stream.destroy(abortError(signal as AbortSignal));
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    throwIfAborted(signal);
    for await (const chunk of stream) {
      throwIfAborted(signal);
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      bytes += buffer.byteLength;
      if (bytes > maxBytes) throw new Error('export manifest exceeds its read limit');
      chunks.push(buffer);
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  return Buffer.concat(chunks);
}

async function verifyDeclaredEntries(
  path: string,
  manifest: GezmodelBundleManifest,
  onProgress: (bytesCompleted: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  const expected = new Map(manifest.files.map((file) => [file.path, file]));
  if (expected.size !== manifest.files.length) {
    throw new Error('export manifest declares duplicate files');
  }
  const zip = await openArchive(path);
  if (signal?.aborted) {
    zip.close();
    throw abortError(signal);
  }
  await new Promise<void>((resolve, reject) => {
    const seen = new Set<string>();
    let bytesCompleted = 0;
    let bytesReported = 0;
    let settled = false;
    let activeStream: NodeReadable | undefined;
    const finish = () => signal?.removeEventListener('abort', onAbort);
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      finish();
      zip.close();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const onAbort = () => {
      const error = abortError(signal as AbortSignal);
      activeStream?.destroy(error);
      fail(error);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    zip.on('error', fail);
    zip.on('entry', (entry) => {
      void (async () => {
        const name = entry.fileName;
        if (seen.has(name)) throw new Error(`export contains a duplicate ZIP entry: ${name}`);
        seen.add(name);
        if (name === 'manifest.json') {
          zip.readEntry();
          return;
        }
        const file = expected.get(name);
        if (!file) throw new Error(`export contains an undeclared file: ${name}`);
        if (entry.uncompressedSize !== file.sizeBytes) {
          throw new Error(`export size verification failed for ${name}`);
        }
        const stream = await openEntryStream(zip, entry);
        activeStream = stream;
        const hash = createHash('sha256');
        let entryBytes = 0;
        for await (const chunk of stream) {
          throwIfAborted(signal);
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
          entryBytes += buffer.byteLength;
          bytesCompleted += buffer.byteLength;
          hash.update(buffer);
          if (bytesCompleted - bytesReported >= PROGRESS_REPORT_BYTES) {
            bytesReported = bytesCompleted;
            onProgress(bytesCompleted);
          }
        }
        activeStream = undefined;
        if (entryBytes !== file.sizeBytes || hash.digest('hex') !== file.sha256) {
          throw new Error(`export checksum verification failed for ${name}`);
        }
        if (bytesCompleted !== bytesReported) {
          bytesReported = bytesCompleted;
          onProgress(bytesCompleted);
        }
        zip.readEntry();
      })().catch(fail);
    });
    zip.on('end', () => {
      if (settled) return;
      for (const file of manifest.files) {
        if (!seen.has(file.path)) {
          fail(new Error(`export is missing declared file: ${file.path}`));
          return;
        }
      }
      settled = true;
      finish();
      resolve();
    });
    zip.readEntry();
  });
}

function openEntryStream(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<NodeReadable> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        reject(error ?? new Error(`could not read ZIP entry: ${entry.fileName}`));
        return;
      }
      resolve(stream);
    });
  });
}
