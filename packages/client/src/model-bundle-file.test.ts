import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { GezmodelBundleManifest } from '@bendyline/gezel';
import { afterEach, describe, expect, it } from 'vitest';
import * as yazl from 'yazl';
import {
  modelBytesFromResponse,
  portableGezmodelFilename,
  verifyModelBundleArchive,
  writeModelBundleResponse,
} from './model-bundle-file.js';

let scratch: string | undefined;

afterEach(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
  scratch = undefined;
});

async function tempPath(name: string): Promise<string> {
  scratch ??= await mkdtemp(join(tmpdir(), 'gezel-model-export-'));
  return join(scratch, name);
}

const MODEL_BYTES = Buffer.from('GGUF-gezel-export-verification-payload', 'utf8');
const INSTALLED_BYTES = Buffer.from('{"id":"test-model"}\n', 'utf8');

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function manifest(): GezmodelBundleManifest {
  return {
    schemaVersion: 1,
    kind: 'gezel-model',
    id: 'test-model',
    name: 'Test model',
    engine: 'llama-cpp',
    createdAt: '2026-08-17T20:00:00.000Z',
    createdBy: 'gezel',
    approxSizeBytes: MODEL_BYTES.byteLength,
    files: [
      {
        path: 'manifests/installed.json',
        sizeBytes: INSTALLED_BYTES.byteLength,
        sha256: sha256(INSTALLED_BYTES),
        role: 'installed-manifest',
      },
      {
        path: 'model/test.gguf',
        sizeBytes: MODEL_BYTES.byteLength,
        sha256: sha256(MODEL_BYTES),
        role: 'model',
      },
    ],
  };
}

async function writeValidBundle(path: string): Promise<void> {
  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from(`${JSON.stringify(manifest())}\n`), 'manifest.json');
  zip.addBuffer(INSTALLED_BYTES, 'manifests/installed.json');
  zip.addBuffer(MODEL_BYTES, 'model/test.gguf', { compress: false });
  zip.end();
  await pipeline(zip.outputStream, createWriteStream(path));
}

describe('desktop .gezmodel export integrity', () => {
  it('durably writes the response and verifies every declared file', async () => {
    const source = await tempPath('source.gezmodel');
    const partial = await tempPath('saved.gezmodel.partial');
    await writeValidBundle(source);
    const archive = await readFile(source);
    const response = new Response(archive, {
      headers: { 'X-Gezel-Model-Bytes': String(MODEL_BYTES.byteLength) },
    });
    const writtenProgress: number[] = [];
    const written = await writeModelBundleResponse(response, partial, (next) => {
      writtenProgress.push(next.bytesCompleted);
      expect(next.bytesTotal).toBe(MODEL_BYTES.byteLength);
    });
    expect(written).toBe(archive.byteLength);
    expect(await readFile(partial)).toEqual(archive);
    expect(writtenProgress.at(-1)).toBe(archive.byteLength);

    const verifiedProgress: number[] = [];
    const verified = await verifyModelBundleArchive(partial, (next) => {
      verifiedProgress.push(next.bytesCompleted);
      expect(next.bytesTotal).toBe(MODEL_BYTES.byteLength + INSTALLED_BYTES.byteLength);
    });
    expect(verified.id).toBe('test-model');
    expect(verifiedProgress.at(-1)).toBe(MODEL_BYTES.byteLength + INSTALLED_BYTES.byteLength);
  });

  it('rejects a truncated archive instead of publishing it', async () => {
    const path = await tempPath('truncated.gezmodel');
    await writeValidBundle(path);
    const complete = await readFile(path);
    await writeFile(path, complete.subarray(0, complete.byteLength - 24));
    await expect(verifyModelBundleArchive(path, () => {})).rejects.toThrow(/readable ZIP archive/);
  });

  it('rejects a payload changed after the service hash pass', async () => {
    const path = await tempPath('changed.gezmodel');
    await writeValidBundle(path);
    const changed = await readFile(path);
    const offset = changed.indexOf(MODEL_BYTES);
    expect(offset).toBeGreaterThan(0);
    changed[offset] = (changed[offset] ?? 0) ^ 0xff;
    await writeFile(path, changed);
    await expect(verifyModelBundleArchive(path, () => {})).rejects.toThrow(
      /checksum verification failed/,
    );
  });

  it('accepts only a safe integer model-size response header', () => {
    expect(
      modelBytesFromResponse(new Response(null, { headers: { 'X-Gezel-Model-Bytes': '8000' } })),
    ).toBe(8000);
    expect(
      modelBytesFromResponse(new Response(null, { headers: { 'X-Gezel-Model-Bytes': '-1' } })),
    ).toBeUndefined();
  });

  it('stops writing when the export is canceled', async () => {
    const path = await tempPath('canceled.gezmodel.partial');
    const controller = new AbortController();
    controller.abort();
    await expect(
      writeModelBundleResponse(
        new Response(Buffer.from('partial bundle')),
        path,
        () => {},
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('stops verification when the export is canceled', async () => {
    const path = await tempPath('cancel-verification.gezmodel.partial');
    await writeValidBundle(path);
    const controller = new AbortController();
    controller.abort();
    await expect(verifyModelBundleArchive(path, () => {}, controller.signal)).rejects.toMatchObject(
      {
        name: 'AbortError',
      },
    );
  });
});

describe('portable export names', () => {
  it('reduces a catalog id to a filesystem-safe .gezmodel name', () => {
    expect(portableGezmodelFilename('qwen:7b/q4')).toBe('qwen-7b-q4.gezmodel');
    expect(portableGezmodelFilename('...')).toBe('model.gezmodel');
  });
});
