import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { ChatModelManifest, GezmodelBundleManifest, GezmodelFile } from '@bendyline/gezel';
import { CatalogService } from '@bendyline/gezel-catalog';
import AdmZip from 'adm-zip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelBundleSource } from './bundle-storage.js';
import { GezmodelManager } from './gezmodel.js';

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezmodel-test-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

interface FakeOwner {
  getModelBundleSource: ReturnType<typeof vi.fn>;
  resolveModel: ReturnType<typeof vi.fn>;
  importModelBundle: ReturnType<typeof vi.fn>;
}

function fakeOwner(source?: ModelBundleSource): FakeOwner {
  return {
    getModelBundleSource: vi.fn(async () => {
      if (!source) throw new Error('not installed');
      return source;
    }),
    resolveModel: vi.fn(async () => null),
    importModelBundle: vi.fn(async () => {}),
  };
}

function manager(owner: FakeOwner, catalog = new CatalogService()): GezmodelManager {
  return new GezmodelManager({
    home,
    catalog,
    llamaCpp: owner as never,
    mlx: owner as never,
    ds4: owner as never,
  });
}

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function sha(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function makeSafetensors(): Buffer {
  const header = Buffer.from(
    JSON.stringify({ weight: { dtype: 'F32', shape: [1], data_offsets: [0, 4] } }),
    'utf8',
  );
  const prefix = Buffer.alloc(8);
  prefix.writeBigUInt64LE(BigInt(header.length));
  return Buffer.concat([prefix, header, Buffer.alloc(4)]);
}

async function catalogManifest(id = 'llama3.2-3b-q4'): Promise<ChatModelManifest> {
  const detail = await new CatalogService().get('chat-model', id);
  if (!detail || detail.manifest.kind !== 'chat-model')
    throw new Error('test catalog model missing');
  return detail.manifest;
}

async function makeMlxBundle(opts?: {
  mutateManifest?: (manifest: GezmodelBundleManifest) => void;
  extra?: { path: string; content: Buffer; role: GezmodelFile['role'] };
}): Promise<Buffer> {
  const catalog = await catalogManifest();
  const installed = Buffer.from(
    JSON.stringify({
      id: catalog.id,
      name: catalog.name,
      installedAt: new Date().toISOString(),
      catalogId: catalog.id,
      catalogVersion: catalog.version,
      files: ['config.json', 'model.safetensors'],
    }),
  );
  const resolved = Buffer.from(JSON.stringify(catalog));
  const config = Buffer.from(JSON.stringify({ architectures: ['LlamaForCausalLM'] }));
  const weights = makeSafetensors();
  const entries: Array<{ path: string; content: Buffer; role: GezmodelFile['role'] }> = [
    { path: 'manifests/installed.json', content: installed, role: 'installed-manifest' },
    { path: 'manifests/catalog.json', content: resolved, role: 'catalog-manifest' },
    { path: 'model/config.json', content: config, role: 'model' },
    { path: 'model/model.safetensors', content: weights, role: 'model' },
    ...(opts?.extra ? [opts.extra] : []),
  ];
  const manifest: GezmodelBundleManifest = {
    schemaVersion: 1,
    kind: 'gezel-model',
    id: catalog.id,
    name: catalog.name,
    engine: 'mlx',
    createdAt: new Date().toISOString(),
    createdBy: 'gezel',
    catalogVersion: catalog.version,
    approxSizeBytes:
      config.length +
      weights.length +
      (opts?.extra?.role === 'model' ? opts.extra.content.length : 0),
    files: entries.map((entry) => ({
      path: entry.path,
      sizeBytes: entry.content.length,
      sha256: sha(entry.content),
      role: entry.role,
    })),
  };
  opts?.mutateManifest?.(manifest);
  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest)));
  for (const entry of entries) zip.addFile(entry.path, entry.content);
  return zip.toBuffer();
}

describe('.gezmodel bundles', () => {
  it('exports model + exact Gezel manifests, then scans and confirms the bundle', async () => {
    const catalog = await catalogManifest();
    const modelDir = join(home, 'source-model');
    await mkdir(modelDir, { recursive: true });
    await writeFile(join(modelDir, 'weights.gguf'), Buffer.from('GGUFtest-model'));
    const source: ModelBundleSource = {
      id: catalog.id,
      name: catalog.name,
      modelDir,
      installedManifest: {
        id: catalog.id,
        name: catalog.name,
        weightsFilename: 'weights.gguf',
        installedAt: new Date().toISOString(),
        catalogVersion: catalog.version,
      },
      modelFiles: ['weights.gguf'],
      catalogVersion: catalog.version,
    };
    const owner = fakeOwner(source);
    owner.importModelBundle.mockImplementation(async (opts: { stagedModelDir: string }) => {
      expect(await readFile(join(opts.stagedModelDir, 'weights.gguf'), 'utf8')).toBe(
        'GGUFtest-model',
      );
    });
    const bundles = manager(owner);

    const exported = await bundles.export('llama-cpp', catalog.id);
    const bytes = await collect(exported.stream);
    const zip = new AdmZip(bytes);
    expect(zip.getEntry('manifest.json')).not.toBeNull();
    expect(zip.getEntry('manifests/installed.json')).not.toBeNull();
    expect(zip.getEntry('manifests/catalog.json')).not.toBeNull();
    expect(zip.getEntry('model/weights.gguf')).not.toBeNull();
    expect(
      zip
        .getEntries()
        .some((entry) => /catalog\/chat-models\/.+\/manifest\.json$/.test(entry.entryName)),
    ).toBe(true);

    const review = await bundles.scanUpload(Readable.from(bytes));
    expect(review.manifest.id).toBe(catalog.id);
    expect(review.alreadyInstalled).toBe(false);
    await expect(
      access(join(home, '.transactions', 'gezmodel-imports', review.importId, 'bundle.gezmodel')),
    ).rejects.toThrow();
    await expect(bundles.confirmImport(review.importId, false)).resolves.toEqual({
      engine: 'llama-cpp',
      id: catalog.id,
    });
    expect(owner.importModelBundle).toHaveBeenCalledOnce();
  });

  it('requires a separate replacement confirmation for an installed model', async () => {
    const owner = fakeOwner();
    owner.resolveModel.mockResolvedValue({ id: 'llama3.2-3b-q4' });
    const bundles = manager(owner);
    const review = await bundles.scanUpload(Readable.from(await makeMlxBundle()));
    expect(review.alreadyInstalled).toBe(true);
    await expect(bundles.confirmImport(review.importId, false)).rejects.toThrow(
      /already exists locally/,
    );
    await expect(bundles.confirmImport(review.importId, true)).resolves.toMatchObject({
      engine: 'mlx',
    });
    expect(owner.importModelBundle).toHaveBeenCalledWith(
      expect.objectContaining({ replace: true }),
    );
  });

  it('rejects checksum tampering before a review token is issued', async () => {
    const bytes = await makeMlxBundle({
      mutateManifest: (manifest) => {
        const config = manifest.files.find((file) => file.path === 'model/config.json');
        if (config) config.sha256 = '0'.repeat(64);
      },
    });
    await expect(manager(fakeOwner()).scanUpload(Readable.from(bytes))).rejects.toThrow(
      /checksum verification failed/,
    );
  });

  it('rejects declared executable/script payloads even when their checksum matches', async () => {
    const bytes = await makeMlxBundle({
      extra: { path: 'model/setup.py', content: Buffer.from('print("no")'), role: 'model' },
    });
    await expect(manager(fakeOwner()).scanUpload(Readable.from(bytes))).rejects.toThrow(
      /executable or script content is not allowed/,
    );
  });
});
