import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CatalogService } from '@bendyline/gezel-catalog';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type MlxInstallEvent, MlxModelManager } from './models.js';

/**
 * End-to-end coverage for the concurrent multi-file MLX install path
 * (Task 4). We serve a model's files from a fake `fetch` and assert:
 *   - the install completes and lands every file on disk,
 *   - cumulative `bytesWrittenAll` reaches the manifest total,
 *   - more than one file is genuinely in flight at once,
 *   - a single bad file fails the install (terminal `error`, no `done`).
 */

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * A Response whose body streams `bytes` in three chunks with a small
 * inter-chunk delay, so concurrent downloads actually overlap in time.
 * `onClose` fires once when the stream is fully drained.
 */
function streamingResponse(bytes: Buffer, onClose: () => void): Response {
  let offset = 0;
  const chunkSize = Math.max(1, Math.ceil(bytes.length / 3));
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        onClose();
        return;
      }
      await new Promise((r) => setTimeout(r, 5));
      const end = Math.min(offset + chunkSize, bytes.length);
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-length': String(bytes.length) },
  });
}

interface Harness {
  manager: MlxModelManager;
  maxConcurrent: () => number;
}

function makeHarness(opts: {
  home: string;
  files: Record<string, Buffer>;
  /** File names present in the manifest but NOT served (force a 404). */
  missing?: string[];
  onInstallStart?: (info: { catalogId: string }) => void;
}): Harness {
  const fileNames = [...Object.keys(opts.files), ...(opts.missing ?? [])];
  const fileList = fileNames.map((name) => {
    const bytes = opts.files[name] ?? Buffer.alloc(0);
    return {
      name,
      // Missing files get a bogus sha; they 404 before verification anyway.
      sha256: opts.files[name] ? sha256(bytes) : '00',
      sizeBytes: opts.files[name] ? bytes.length : 1,
    };
  });

  const catalog = {
    get: async (kind: string, id: string) => {
      if (kind !== 'chat-model') return null;
      return {
        manifest: {
          kind: 'chat-model',
          id,
          name: 'Test MLX Model',
          version: '1',
          mlx: {
            huggingfaceRepo: 'test/repo',
            revision: 'deadbeef',
            approxSizeBytes: fileList.reduce((s, f) => s + f.sizeBytes, 0),
            files: fileList,
          },
        },
      } as unknown as Awaited<ReturnType<CatalogService['get']>>;
    },
  } as unknown as CatalogService;

  let active = 0;
  let max = 0;
  const fetchImpl = (async (url: string) => {
    const name = decodeURIComponent((url.split('/').pop() ?? '').split('?')[0] ?? '');
    const bytes = opts.files[name];
    if (!bytes) {
      return new Response(null, { status: 404, statusText: 'Not Found' });
    }
    active += 1;
    max = Math.max(max, active);
    return streamingResponse(bytes, () => {
      active -= 1;
    });
  }) as unknown as typeof fetch;

  const manager = new MlxModelManager({
    home: opts.home,
    catalog,
    fetchImpl,
    ...(opts.onInstallStart ? { onInstallStart: opts.onInstallStart } : {}),
  });
  return { manager, maxConcurrent: () => max };
}

async function drain(iter: AsyncIterable<MlxInstallEvent>): Promise<MlxInstallEvent[]> {
  const events: MlxInstallEvent[] = [];
  for await (const ev of iter) events.push(ev);
  return events;
}

describe('MlxModelManager — concurrent multi-file install', () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'gezel-mlx-install-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('keeps an older manifest visible for catalog update or removal', async () => {
    const id = 'legacy-mlx-model';
    const dir = join(home, 'engines', 'mlx', 'models', id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'model.safetensors'), Buffer.from('legacy-weights'));
    await writeFile(
      join(dir, 'manifest.json'),
      JSON.stringify({
        id,
        engine: 'mlx',
        huggingfaceRepo: 'test/old-repo',
        files: ['model.safetensors'],
      }),
    );
    const { manager } = makeHarness({
      home,
      files: { 'model.safetensors': Buffer.from('current-weights') },
    });

    await expect(manager.listInstalled()).resolves.toEqual([]);
    await expect(manager.listUnrecognized()).resolves.toEqual([
      expect.objectContaining({
        id,
        name: 'Test MLX Model',
        canUpdate: true,
        bytes: expect.any(Number),
        reason: expect.stringContaining('does not match the current format'),
      }),
    ]);

    await manager.delete(id);
    await expect(readdir(join(home, 'engines', 'mlx', 'models'))).resolves.toEqual([]);
  });

  it('downloads several files concurrently and completes', async () => {
    const files: Record<string, Buffer> = {
      'config.json': Buffer.from(JSON.stringify({ architectures: ['Gemma3'] })),
      'tokenizer_config.json': Buffer.from(JSON.stringify({ chat_template: 'x' })),
      'model-00001.safetensors': Buffer.from('a'.repeat(900)),
      'model-00002.safetensors': Buffer.from('b'.repeat(900)),
      'model-00003.safetensors': Buffer.from('c'.repeat(900)),
    };
    const { manager, maxConcurrent } = makeHarness({ home, files });

    const events = await drain(manager.install('test-model'));

    // Completed with a terminal done, no error.
    expect(events.some((e) => e.type === 'done')).toBe(true);
    expect(events.some((e) => e.type === 'error')).toBe(false);

    // More than one file genuinely in flight at once (proves parallelism).
    expect(maxConcurrent()).toBeGreaterThan(1);

    // Cumulative progress reached the manifest total at least once.
    const totalAll = Object.values(files).reduce((s, b) => s + b.length, 0);
    const peak = events
      .filter((e): e is Extract<MlxInstallEvent, { type: 'progress' }> => e.type === 'progress')
      .reduce((m, e) => Math.max(m, e.bytesWrittenAll), 0);
    expect(peak).toBe(totalAll);

    // Every file landed on disk (renamed off `.partial`).
    const onDisk = await readdir(join(home, 'engines', 'mlx', 'models', 'test-model'));
    for (const name of Object.keys(files)) expect(onDisk).toContain(name);
    expect(onDisk).toContain('manifest.json');
  });

  it('starts runtime warming for installs initiated through the direct model manager', async () => {
    const files: Record<string, Buffer> = {
      'config.json': Buffer.from(JSON.stringify({ architectures: ['Gemma3'] })),
      'model.safetensors': Buffer.from('weights'),
    };
    const starts: string[] = [];
    const { manager } = makeHarness({
      home,
      files,
      onInstallStart: ({ catalogId }) => starts.push(catalogId),
    });

    await drain(manager.install('test-model'));

    expect(starts).toEqual(['test-model']);
  });

  it('fails the whole install when one file is unavailable (no done event)', async () => {
    const files: Record<string, Buffer> = {
      'config.json': Buffer.from('{}'),
      'model-00001.safetensors': Buffer.from('a'.repeat(600)),
    };
    const { manager } = makeHarness({
      home,
      files,
      missing: ['model-00002.safetensors'],
    });

    const events = await drain(manager.install('test-model'));

    const error = events.find(
      (e): e is Extract<MlxInstallEvent, { type: 'error' }> => e.type === 'error',
    );
    expect(error).toBeTruthy();
    expect(error?.error).toContain('model-00002.safetensors');
    expect(events.some((e) => e.type === 'done')).toBe(false);

    // No manifest written — the model wasn't committed.
    const modelDir = join(home, 'engines', 'mlx', 'models', 'test-model');
    const onDisk = await readdir(modelDir).catch(() => [] as string[]);
    expect(onDisk).not.toContain('manifest.json');
  });

  it('detects a sha256 mismatch and surfaces the offending file', async () => {
    const good = Buffer.from('a'.repeat(600));
    // Catalog pins a sha that does NOT match the bytes we serve, so
    // verification must fail with a `mismatch` and no `done`.
    const catalog = {
      get: async (kind: string, id: string) =>
        kind !== 'chat-model'
          ? null
          : ({
              manifest: {
                kind: 'chat-model',
                id,
                name: 'M',
                version: '1',
                mlx: {
                  huggingfaceRepo: 'test/repo',
                  revision: 'r',
                  approxSizeBytes: 602,
                  files: [
                    { name: 'config.json', sha256: sha256(Buffer.from('{}')), sizeBytes: 2 },
                    { name: 'model.safetensors', sha256: 'deadbeef', sizeBytes: good.length },
                  ],
                },
              },
            } as unknown as Awaited<ReturnType<CatalogService['get']>>),
    } as unknown as CatalogService;
    const fetchImpl = (async (url: string) => {
      const name = decodeURIComponent((url.split('/').pop() ?? '').split('?')[0] ?? '');
      return streamingResponse(name === 'config.json' ? Buffer.from('{}') : good, () => {});
    }) as unknown as typeof fetch;
    const manager = new MlxModelManager({ home, catalog, fetchImpl });

    const events = await drain(manager.install('m'));
    const error = events.find(
      (e): e is Extract<MlxInstallEvent, { type: 'error' }> => e.type === 'error',
    );
    expect(error?.mismatch?.file).toBe('model.safetensors');
    expect(events.some((e) => e.type === 'done')).toBe(false);
  });
});
