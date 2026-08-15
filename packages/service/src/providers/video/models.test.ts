import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CatalogService } from '@bendyline/gezel-catalog';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReadOnlyModelError, hashModelPayloadFiles } from '../../models/storage-roots.js';
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
