import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CatalogService } from '@bendyline/gezel-catalog';
import {
  ReadOnlyModelError,
  hashModelPayloadFiles,
} from '@bendyline/gezel-inference/internal/models/storage-roots';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VideoModelManager } from './models.js';

const tempRoots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'gezel-video-models-'));
  tempRoots.push(home);
  return home;
}

async function placeModel(dir: string, id: string): Promise<void> {
  const modelDir = join(dir, id);
  await mkdir(modelDir, { recursive: true });
  await writeFile(join(modelDir, 'model_index.json'), '{}');
  const manifest = {
    id,
    name: id,
    approxSizeBytes: 2,
    installedAt: '2026-08-01T00:00:00.000Z',
    catalogId: id,
    catalogVersion: '1.0.0',
    family: 'wan',
    huggingfaceRepo: 'example/repo',
    files: ['model_index.json'],
    fileSha256: await hashModelPayloadFiles(modelDir),
  };
  await writeFile(join(modelDir, 'manifest.json'), JSON.stringify(manifest));
}

function manager(home: string): VideoModelManager {
  return new VideoModelManager({ home, catalog: {} as CatalogService });
}

describe('VideoModelManager machine asset store overlay', () => {
  it('marks shared-store models readOnly and refuses to delete them', async () => {
    const home = await tempHome();
    const shared = join(home, 'public-assets');
    vi.stubEnv('GEZEL_SHARED_ASSETS_DIR', shared);
    await placeModel(join(shared, 'models', 'video'), 'wan2.2-ti2v-5b');

    const models = manager(home);
    const installed = await models.listInstalled();
    expect(installed).toHaveLength(1);
    expect(installed[0]).toMatchObject({ id: 'wan2.2-ti2v-5b', readOnly: true });

    const rejection = await models.delete('wan2.2-ti2v-5b').catch((err: unknown) => err);
    expect(rejection).toBeInstanceOf(ReadOnlyModelError);
    expect((rejection as ReadOnlyModelError).code).toBe('read-only-model');
    // Refusal must not have touched the shared store.
    expect(await models.listInstalled()).toHaveLength(1);
  });

  it('marks user-owned models writable and deletes them', async () => {
    const home = await tempHome();
    await placeModel(join(home, 'engines', 'video', 'models'), 'ltx-2.3-22b-fp8');

    const models = manager(home);
    const installed = await models.listInstalled();
    expect(installed[0]).toMatchObject({ id: 'ltx-2.3-22b-fp8', readOnly: false });

    await models.delete('ltx-2.3-22b-fp8');
    expect(await models.listInstalled()).toHaveLength(0);
  });
});

describe('VideoModelManager sd.cpp store', () => {
  const sha = async (text: string) =>
    (await import('node:crypto')).createHash('sha256').update(text).digest('hex');

  async function sdCppCatalog(files: Array<{ name: string; body: string; role?: string }>) {
    const manifest = {
      kind: 'video-model',
      id: 'wan2.2-ti2v-5b-q4',
      name: 'Wan 2.2 TI2V-5B (Q4)',
      version: '1.0.0',
      engine: 'sd-cpp',
      family: 'wan',
      architecture: 'wan2.2-ti2v-5b',
      sdCpp: { flowShift: 5 },
      recommendedSteps: 20,
      defaultNumFrames: 121,
      defaultFps: 24,
      defaultWidth: 1280,
      defaultHeight: 704,
      supportsImageToVideo: true,
      source: {
        huggingfaceRepo: 'example/repo',
        approxSizeBytes: 6,
        files: await Promise.all(
          files.map(async (f) => ({
            name: f.name,
            sha256: await sha(f.body),
            sizeBytes: f.body.length,
            ...(f.role ? { role: f.role } : {}),
          })),
        ),
      },
    };
    const catalog = { get: async () => ({ manifest }) } as unknown as CatalogService;
    const fetchImpl = (async (url: string) => {
      const file = files.find((f) => url.includes(encodeURIComponent(f.name)));
      return new Response(file?.body ?? '', { status: file ? 200 : 404 });
    }) as unknown as typeof fetch;
    return { catalog, fetchImpl };
  }

  async function drain(events: AsyncIterable<{ type: string; error?: string }>) {
    const out: Array<{ type: string; error?: string }> = [];
    for await (const ev of events) out.push(ev);
    return out;
  }

  it('installs an sd.cpp model into its own store with each file by slot', async () => {
    const home = await tempHome();
    const { catalog, fetchImpl } = await sdCppCatalog([
      { name: 'model-Q4.gguf', body: 'dit', role: 'diffusion_model' },
      { name: 'umt5-Q4.gguf', body: 'te', role: 't5xxl' },
      { name: 'wan2.2_vae.safetensors', body: 'v', role: 'vae' },
    ]);
    const models = new VideoModelManager({ home, catalog, fetchImpl });
    const events = await drain(models.install('wan2.2-ti2v-5b-q4'));
    expect(events.at(-1)).toEqual({ type: 'done', id: 'wan2.2-ti2v-5b-q4' });

    const installed = await models.resolveModel('wan2.2-ti2v-5b-q4');
    expect(installed).toMatchObject({
      engine: 'sd-cpp',
      architecture: 'wan2.2-ti2v-5b',
      supportsImageToVideo: true,
      imageToVideoOnly: false,
      hasAudio: false,
      defaultWidth: 1280,
      recommendedSteps: 20,
      sdCpp: { flowShift: 5 },
    });
    const store = join(home, 'engines', 'sd-cpp-video', 'models', 'wan2.2-ti2v-5b-q4');
    expect(installed?.modelDir).toBe(store);
    expect(installed?.components).toEqual([
      { role: 'diffusion_model', path: join(store, 'model-Q4.gguf') },
      { role: 't5xxl', path: join(store, 'umt5-Q4.gguf') },
      { role: 'vae', path: join(store, 'wan2.2_vae.safetensors') },
    ]);
    expect(await models.resolveModel('wan2.2-ti2v-5b-q4', 'diffusers')).toBeNull();
    expect(await models.listInstalled('diffusers')).toEqual([]);

    await models.delete('wan2.2-ti2v-5b-q4');
    expect(await models.listInstalled()).toEqual([]);
  });

  it('refuses an sd.cpp entry whose files do not name their slots', async () => {
    const home = await tempHome();
    const { catalog, fetchImpl } = await sdCppCatalog([
      { name: 'model-Q4.gguf', body: 'dit', role: 'diffusion_model' },
      { name: 'umt5-Q4.gguf', body: 'te' },
    ]);
    const events = await drain(
      new VideoModelManager({ home, catalog, fetchImpl }).install('wan2.2-ti2v-5b-q4'),
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.error).toMatch(/umt5-Q4\.gguf does not say which sd-server slot/);
  });

  it('reads a record written before engines existed as a diffusers model', async () => {
    const home = await tempHome();
    await placeModel(join(home, 'engines', 'video', 'models'), 'wan2.2-ti2v-5b');
    const installed = await manager(home).resolveModel('wan2.2-ti2v-5b');
    expect(installed).toMatchObject({
      engine: 'diffusers',
      supportsImageToVideo: false,
      imageToVideoOnly: false,
      hasAudio: false,
    });
    expect(installed?.components).toBeUndefined();
  });

  it('ignores a record in the sd.cpp store that lists no slots', async () => {
    const home = await tempHome();
    await placeModel(join(home, 'engines', 'sd-cpp-video', 'models'), 'stray');
    expect(await manager(home).listInstalled()).toEqual([]);
  });
});
