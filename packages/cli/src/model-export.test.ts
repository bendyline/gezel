import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { crc32 } from 'node:zlib';
import type { GezmodelBundleManifest } from '@bendyline/gezel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ModelExportClient,
  type ModelExportOutput,
  exportModelToFile,
  resolveExportPath,
} from './model-export.js';

let scratch: string | undefined;

afterEach(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
  scratch = undefined;
});

async function scratchDir(): Promise<string> {
  scratch = await mkdtemp(join(tmpdir(), 'gezel-cli-export-'));
  return scratch;
}

/**
 * A store-only ZIP, built by hand so this suite needs no archive library.
 * The service is what really writes `.gezmodel` files; all this fixture has
 * to do is satisfy the shared verifier the CLI runs over the result.
 */
function storeOnlyZip(entries: ReadonlyArray<{ name: string; body: Buffer }>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const { name, body } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const sum = crc32(body);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(body.byteLength, 18);
    local.writeUInt32LE(body.byteLength, 22);
    local.writeUInt16LE(nameBytes.byteLength, 26);
    locals.push(local, nameBytes, body);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt32LE(sum, 16);
    header.writeUInt32LE(body.byteLength, 20);
    header.writeUInt32LE(body.byteLength, 24);
    header.writeUInt16LE(nameBytes.byteLength, 28);
    header.writeUInt32LE(offset, 42);
    central.push(header, nameBytes);

    offset += local.byteLength + nameBytes.byteLength + body.byteLength;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.byteLength, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, directory, end]);
}

/** A minimal, self-consistent `.gezmodel` the real verifier accepts. */
function bundleBytes(opts: { corruptHash?: boolean } = {}): Buffer {
  const weights = Buffer.from('weights', 'utf8');
  const installed = Buffer.from('{"id":"demo-model"}\n', 'utf8');
  const digest = (body: Buffer, corrupt = false): string =>
    createHash('sha256')
      .update(corrupt ? 'something else entirely' : body)
      .digest('hex');

  const manifest: GezmodelBundleManifest = {
    schemaVersion: 1,
    kind: 'gezel-model',
    id: 'demo-model',
    name: 'Demo Model',
    engine: 'llama-cpp',
    createdAt: new Date(0).toISOString(),
    createdBy: 'gezel',
    approxSizeBytes: weights.byteLength,
    files: [
      {
        path: 'manifests/installed.json',
        sizeBytes: installed.byteLength,
        sha256: digest(installed),
        role: 'installed-manifest',
      },
      {
        path: 'model/weights.gguf',
        sizeBytes: weights.byteLength,
        sha256: digest(weights, opts.corruptHash),
        role: 'model',
      },
    ],
  };

  return storeOnlyZip([
    { name: 'manifest.json', body: Buffer.from(`${JSON.stringify(manifest)}\n`, 'utf8') },
    { name: 'manifests/installed.json', body: installed },
    { name: 'model/weights.gguf', body: weights },
  ]);
}

function silentOutput(): ModelExportOutput & { text: string } {
  const sink = {
    text: '',
    writeProgress(value: string) {
      sink.text += value;
    },
  };
  return sink;
}

function clientFor(opts: { installed?: string[]; archive?: Buffer } = {}) {
  const installed = new Set(opts.installed ?? ['demo-model']);
  const installLlamaCppModel = vi.fn(
    async (id: string, listener: (event: { type: 'done' }) => void) => {
      installed.add(id);
      listener({ type: 'done' });
    },
  );
  const exportModelBundle = vi.fn(async () => {
    const archive = opts.archive ?? bundleBytes();
    return new Response(new Uint8Array(archive), {
      headers: { 'x-gezel-model-bytes': String(archive.byteLength) },
    });
  });
  const client = {
    exportModelBundle,
    installLlamaCppModel,
    installMlxModel: vi.fn(),
    installDs4Model: vi.fn(),
    listLlamaCppModels: vi.fn(async () => ({
      models: [...installed].map((id) => ({ id, name: id, approxSizeBytes: 7 })),
    })),
    listMlxModels: vi.fn(async () => ({ models: [] })),
    listDs4Models: vi.fn(async () => ({ models: [] })),
  };
  return client as unknown as ModelExportClient & typeof client;
}

describe('resolveExportPath', () => {
  it('defaults to the portable name in the working directory', async () => {
    await expect(resolveExportPath('qwen:7b/q4', undefined, '/work')).resolves.toBe(
      resolve('/work', 'qwen-7b-q4.gezmodel'),
    );
  });

  it('adds the extension to a bare name and keeps an explicit one', async () => {
    await expect(resolveExportPath('demo', 'ship-it', '/work')).resolves.toBe(
      resolve('/work', 'ship-it.gezmodel'),
    );
    await expect(resolveExportPath('demo', 'ship-it.gezmodel', '/work')).resolves.toBe(
      resolve('/work', 'ship-it.gezmodel'),
    );
  });

  it('treats an existing directory as a destination folder', async () => {
    const dir = await scratchDir();
    await expect(resolveExportPath('demo-model', dir, '/work')).resolves.toBe(
      resolve(dir, 'demo-model.gezmodel'),
    );
  });
});

describe('exportModelToFile', () => {
  it('exports an installed model and verifies the archive', async () => {
    const dir = await scratchDir();
    const client = clientFor();
    const result = await exportModelToFile(client, 'demo-model', {
      engine: 'llama-cpp',
      cwd: dir,
      output: silentOutput(),
    });

    expect(result.pulled).toBe(false);
    expect(result.path).toBe(resolve(dir, 'demo-model.gezmodel'));
    expect((await stat(result.path)).isFile()).toBe(true);
    expect(await readdir(dir)).toEqual(['demo-model.gezmodel']);
    expect(client.installLlamaCppModel).not.toHaveBeenCalled();
  });

  it('downloads a model that is not installed yet, then exports it', async () => {
    const dir = await scratchDir();
    const client = clientFor({ installed: [] });
    const result = await exportModelToFile(client, 'demo-model', {
      engine: 'llama-cpp',
      cwd: dir,
      output: silentOutput(),
    });

    expect(result.pulled).toBe(true);
    expect(client.installLlamaCppModel).toHaveBeenCalledWith('demo-model', expect.any(Function));
  });

  it('refuses to download when --no-pull is set', async () => {
    const dir = await scratchDir();
    const client = clientFor({ installed: [] });
    await expect(
      exportModelToFile(client, 'demo-model', {
        engine: 'llama-cpp',
        cwd: dir,
        skipPull: true,
        output: silentOutput(),
      }),
    ).rejects.toThrow(/not installed/);
    expect(client.exportModelBundle).not.toHaveBeenCalled();
  });

  it('refuses to clobber an existing export without --force', async () => {
    const dir = await scratchDir();
    const target = join(dir, 'demo-model.gezmodel');
    await writeFile(target, 'previous export');
    const client = clientFor();

    await expect(
      exportModelToFile(client, 'demo-model', {
        engine: 'llama-cpp',
        cwd: dir,
        output: silentOutput(),
      }),
    ).rejects.toThrow(/already exists/);
    await expect(readFile(target, 'utf8')).resolves.toBe('previous export');

    await exportModelToFile(client, 'demo-model', {
      engine: 'llama-cpp',
      cwd: dir,
      force: true,
      output: silentOutput(),
    });
    expect((await stat(target)).size).toBeGreaterThan('previous export'.length);
    expect(await readdir(dir)).toEqual(['demo-model.gezmodel']);
  });

  it('leaves no partial behind when the archive fails verification', async () => {
    const dir = await scratchDir();
    const client = clientFor({ archive: bundleBytes({ corruptHash: true }) });

    await expect(
      exportModelToFile(client, 'demo-model', {
        engine: 'llama-cpp',
        cwd: dir,
        output: silentOutput(),
      }),
    ).rejects.toThrow(/checksum verification failed/);

    expect(await readdir(dir)).toEqual([]);
  });
});
