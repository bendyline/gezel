import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  findModelRoot,
  hashModelPayloadFiles,
  listOverlayModelIds,
  migrateLegacySystemModels,
  modelStorageRoots,
  verifyReadOnlyModelPayload,
} from './storage-roots.js';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'gezel-model-overlay-'));
  tempRoots.push(root);
  return root;
}

describe('model storage overlay', () => {
  it('writes machine-service models only to the public asset store', async () => {
    const home = await tempRoot();
    const shared = join(home, 'public-assets');
    const roots = modelStorageRoots({
      home,
      engine: 'llama-cpp',
      env: { GEZEL_SYSTEM_SCOPE: '1', GEZEL_SHARED_ASSETS_DIR: shared },
    });
    expect(roots.writableRoot).toBe(join(shared, 'models', 'llama-cpp'));
    expect(roots.readOnlyRoots).toEqual([]);
  });

  it('prefers a user model and falls through incomplete local directories', async () => {
    const home = await tempRoot();
    const shared = join(home, 'public-assets');
    const env = { GEZEL_SHARED_ASSETS_DIR: shared };
    const roots = modelStorageRoots({ home, engine: 'llama-cpp', env });
    await mkdir(join(roots.writableRoot, 'same'), { recursive: true });
    await mkdir(join(shared, 'models', 'llama-cpp', 'same'), { recursive: true });
    await writeFile(join(shared, 'models', 'llama-cpp', 'same', 'manifest.json'), '{}');

    expect(await listOverlayModelIds(roots)).toEqual(['same']);
    expect(await findModelRoot(roots, 'same')).toBe(join(shared, 'models', 'llama-cpp'));

    await writeFile(join(roots.writableRoot, 'same', 'manifest.json'), '{}');
    expect(await findModelRoot(roots, 'same')).toBe(roots.writableRoot);
  });

  it('rehashes a shared model whenever file identity metadata changes', async () => {
    const home = await tempRoot();
    const shared = join(home, 'public-assets');
    const roots = modelStorageRoots({
      home,
      engine: 'llama-cpp',
      env: { GEZEL_SHARED_ASSETS_DIR: shared },
    });
    const modelRoot = join(shared, 'models', 'llama-cpp');
    const modelDir = join(modelRoot, 'test');
    await mkdir(modelDir, { recursive: true });
    await writeFile(join(modelDir, 'weights.gguf'), 'trusted');
    await writeFile(join(modelDir, 'manifest.json'), '{}');
    const expected = await hashModelPayloadFiles(modelDir);

    expect(await verifyReadOnlyModelPayload(roots, modelRoot, 'test', expected)).toBe(true);
    const cache = JSON.parse(
      await readFile(join(home, 'engines', 'llama-cpp', 'shared-model-verification.json'), 'utf8'),
    );
    expect(Object.keys(cache)).toHaveLength(1);

    await writeFile(join(modelDir, 'weights.gguf'), 'altered');
    await utimes(join(modelDir, 'weights.gguf'), new Date(), new Date(Date.now() + 2_000));
    expect(await verifyReadOnlyModelPayload(roots, modelRoot, 'test', expected)).toBe(false);
    expect(expected['weights.gguf']).toBe(createHash('sha256').update('trusted').digest('hex'));
  });

  it('moves legacy system models and backfills their public payload hashes', async () => {
    const home = await tempRoot();
    const shared = join(home, 'public-assets');
    const legacyModel = join(home, 'engines', 'llama-cpp', 'models', 'legacy');
    await mkdir(legacyModel, { recursive: true });
    await writeFile(join(legacyModel, 'weights.gguf'), 'trusted');
    await writeFile(join(legacyModel, 'manifest.json'), '{"id":"legacy"}\n');

    const env = { GEZEL_SYSTEM_SCOPE: '1', GEZEL_SHARED_ASSETS_DIR: shared };
    await expect(migrateLegacySystemModels(home, env)).resolves.toBe(1);

    const sharedModel = join(shared, 'models', 'llama-cpp', 'legacy');
    const manifest = JSON.parse(await readFile(join(sharedModel, 'manifest.json'), 'utf8'));
    expect(manifest.fileSha256).toEqual({
      'weights.gguf': createHash('sha256').update('trusted').digest('hex'),
    });

    const standaloneRoots = modelStorageRoots({
      home: join(home, 'standalone'),
      engine: 'llama-cpp',
      env: { GEZEL_SHARED_ASSETS_DIR: shared },
    });
    await expect(
      verifyReadOnlyModelPayload(
        standaloneRoots,
        join(shared, 'models', 'llama-cpp'),
        'legacy',
        manifest.fileSha256,
      ),
    ).resolves.toBe(true);
  });
});
