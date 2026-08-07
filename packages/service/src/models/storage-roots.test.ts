import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  findModelRoot,
  hashModelPayloadFiles,
  listIncompleteModelDownloads,
  listOverlayModelIds,
  migrateLegacySystemModels,
  modelStorageRoots,
  pruneModelPayloadFiles,
  reclaimAbandonedModelDownloads,
  removeModelDir,
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

  it('reuses precomputed digests and only hashes uncached payload files', async () => {
    const modelDir = await tempRoot();
    await writeFile(join(modelDir, 'weights.gguf'), 'trusted');
    await writeFile(join(modelDir, 'stale-shard.gguf'), 'leftover');
    await writeFile(join(modelDir, 'manifest.json'), '{}');

    const sentinel = 'a'.repeat(64);
    const map = await hashModelPayloadFiles(modelDir, { 'weights.gguf': sentinel });

    expect(map['weights.gguf']).toBe(sentinel);
    expect(map['stale-shard.gguf']).toBe(createHash('sha256').update('leftover').digest('hex'));
    expect(map['manifest.json']).toBeUndefined();
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

  it('never surfaces dot-directories (publish backups) as model ids', async () => {
    const home = await tempRoot();
    const roots = modelStorageRoots({ home, engine: 'llama-cpp', env: {} });
    await mkdir(join(roots.writableRoot, 'real-model'), { recursive: true });
    await mkdir(join(roots.writableRoot, '.real-model.gezmodel-backup-1234'), { recursive: true });

    expect(await listOverlayModelIds(roots)).toEqual(['real-model']);
  });

  it('ignores in-flight .partial files and OS dot-files during shared verification', async () => {
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

    await writeFile(join(modelDir, 'weights-update.gguf.partial'), 'interrupted');
    await writeFile(join(modelDir, '.DS_Store'), 'finder');
    expect(await verifyReadOnlyModelPayload(roots, modelRoot, 'test', expected)).toBe(true);
  });

  it('reports a rejection reason for a shared manifest without payload hashes', async () => {
    const home = await tempRoot();
    const shared = join(home, 'public-assets');
    const roots = modelStorageRoots({
      home,
      engine: 'llama-cpp',
      env: { GEZEL_SHARED_ASSETS_DIR: shared },
    });
    const modelRoot = join(shared, 'models', 'llama-cpp');
    await mkdir(join(modelRoot, 'test'), { recursive: true });

    const reasons: string[] = [];
    expect(
      await verifyReadOnlyModelPayload(roots, modelRoot, 'test', undefined, (reason) =>
        reasons.push(reason),
      ),
    ).toBe(false);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('fileSha256');
  });

  it('reclaims only stale manifest-less directories containing .partial files', async () => {
    const home = await tempRoot();
    const roots = modelStorageRoots({ home, engine: 'mlx', env: {} });
    const root = roots.writableRoot;
    const weekAndDayLater = Date.now() + 8 * 24 * 60 * 60 * 1000;

    // Abandoned download: .partial files, no manifest — reclaim after TTL.
    await mkdir(join(root, 'abandoned'), { recursive: true });
    await writeFile(join(root, 'abandoned', 'model-00001.safetensors.partial'), 'half');
    await writeFile(join(root, 'abandoned', 'config.json'), '{}');
    // Completed install: manifest present — never touched.
    await mkdir(join(root, 'installed'), { recursive: true });
    await writeFile(join(root, 'installed', 'manifest.json'), '{}');
    await writeFile(join(root, 'installed', 'weights.gguf.partial'), 'update-in-flight');
    // Hand-placed directory: no .partial signature — never touched.
    await mkdir(join(root, 'hand-placed'), { recursive: true });
    await writeFile(join(root, 'hand-placed', 'weights.gguf'), 'mine');
    // In-flight install: excluded via activeIds even when stale.
    await mkdir(join(root, 'downloading'), { recursive: true });
    await writeFile(join(root, 'downloading', 'weights.gguf.partial'), 'streaming');

    const reclaimed = await reclaimAbandonedModelDownloads({
      writableRoot: root,
      activeIds: new Set(['downloading']),
      now: weekAndDayLater,
    });
    expect(reclaimed).toEqual([{ id: 'abandoned', bytes: 6 }]);
    expect(await listOverlayModelIds(roots)).toEqual(
      expect.arrayContaining(['installed', 'hand-placed', 'downloading']),
    );

    // Within the TTL the .partial files are resume credit — left alone.
    await mkdir(join(root, 'fresh'), { recursive: true });
    await writeFile(join(root, 'fresh', 'weights.gguf.partial'), 'young');
    expect(await reclaimAbandonedModelDownloads({ writableRoot: root })).toEqual([]);
  });

  it('lists incomplete downloads (no manifest, has bytes), excluding installs and active ids', async () => {
    const root = await tempRoot();
    // Installed: manifest present → never an incomplete row.
    await mkdir(join(root, 'installed'), { recursive: true });
    await writeFile(join(root, 'installed', 'manifest.json'), '{}');
    await writeFile(join(root, 'installed', 'weights.gguf'), 'done');
    // Interrupted: a .partial, no manifest → incomplete, hasPartial true.
    await mkdir(join(root, 'interrupted'), { recursive: true });
    await writeFile(join(root, 'interrupted', 'weights.gguf.partial'), 'partial-bytes'); // 13 B
    // Stray payload with no manifest and no .partial → still hidden disk,
    // surfaced with hasPartial false.
    await mkdir(join(root, 'stray'), { recursive: true });
    await writeFile(join(root, 'stray', 'weights.gguf'), 'orphaned-weights-bigger'); // 23 B
    // In-flight install: excluded via activeIds (shows as live progress).
    await mkdir(join(root, 'downloading'), { recursive: true });
    await writeFile(join(root, 'downloading', 'weights.gguf.partial'), 'streaming');
    // Empty dir: no bytes → not surfaced.
    await mkdir(join(root, 'empty'), { recursive: true });

    const rows = await listIncompleteModelDownloads({
      writableRoot: root,
      activeIds: new Set(['downloading']),
    });
    // Sorted largest-first; installed/downloading/empty excluded.
    expect(rows.map((r) => r.id)).toEqual(['stray', 'interrupted']);
    expect(rows[0]).toMatchObject({ id: 'stray', bytes: 23, hasPartial: false });
    expect(rows[1]).toMatchObject({ id: 'interrupted', bytes: 13, hasPartial: true });
    expect(typeof rows[0]?.updatedAt).toBe('string');
  });

  it('removeModelDir deletes the model directory recursively', async () => {
    const parent = await tempRoot();
    const modelDir = join(parent, 'gemma4-12b-q8');
    await mkdir(modelDir, { recursive: true });
    await writeFile(join(modelDir, 'weights.gguf'), 'bytes');
    await writeFile(join(modelDir, 'manifest.json'), '{}');

    await removeModelDir(modelDir);

    expect(await listOverlayModelIds({ writableRoot: parent, readOnlyRoots: [] })).not.toContain(
      'gemma4-12b-q8',
    );
  });

  it('prunes stale payload files not referenced by the new install, keeping manifest and partials', async () => {
    const modelDir = await tempRoot();
    // Superseded quant from a prior install (should be pruned).
    await writeFile(join(modelDir, 'old-Q4_K_M.gguf'), 'old-weights');
    // Current weights (kept).
    await writeFile(join(modelDir, 'new-qat-Q4_K_XL.gguf'), 'new-weights');
    // Never candidates: the manifest and an in-flight partial.
    await writeFile(join(modelDir, 'manifest.json'), '{}');
    await writeFile(join(modelDir, 'other.gguf.partial'), 'in-flight');

    const removed = await pruneModelPayloadFiles(modelDir, new Set(['new-qat-Q4_K_XL.gguf']));

    expect(removed).toEqual(['old-Q4_K_M.gguf']);
    const left = (await hashModelPayloadFiles(modelDir)) as Record<string, string>;
    expect(Object.keys(left)).toEqual(['new-qat-Q4_K_XL.gguf']); // manifest + .partial excluded
    // The kept and non-candidate files survive on disk.
    expect(await readFile(join(modelDir, 'new-qat-Q4_K_XL.gguf'), 'utf8')).toBe('new-weights');
    expect(await readFile(join(modelDir, 'other.gguf.partial'), 'utf8')).toBe('in-flight');
  });

  // Regression: v1.26219.44 shipped this loop with publishMigratedModel
  // unguarded. On Windows the installer had just made Administrators the owner
  // of every pre-existing model while granting the service only Modify, so the
  // `icacls /reset` inside makeSharedModelReadable failed with "Access is
  // denied", the throw escaped startService, and gezeld crash-looped on SCM
  // 1066 — on every upgrade over an install that already had models. Widening
  // read access on one bundle must never decide whether the daemon boots.
  it('keeps migrating when one bundle cannot be published for shared reading', async () => {
    const home = await tempRoot();
    const shared = join(home, 'public-assets');
    const legacyRoot = join(home, 'engines', 'llama-cpp', 'models');

    // A bundle that publishes cleanly.
    const healthy = join(legacyRoot, 'healthy');
    await mkdir(healthy, { recursive: true });
    await writeFile(join(healthy, 'weights.gguf'), 'good');
    await writeFile(join(healthy, 'manifest.json'), '{"id":"healthy"}\n');

    // A bundle whose publish step throws. A symlink in the payload is the
    // portable stand-in for the Windows ACL denial — listModelPayloadFiles
    // refuses it while backfilling hashes, so the throw escapes
    // publishMigratedModel exactly where the icacls failure did.
    const poisoned = join(legacyRoot, 'poisoned');
    await mkdir(poisoned, { recursive: true });
    await writeFile(join(poisoned, 'weights.gguf'), 'also-good');
    await writeFile(join(poisoned, 'manifest.json'), '{"id":"poisoned"}\n');
    await symlink(join(poisoned, 'weights.gguf'), join(poisoned, 'alias.gguf'));

    const env = { GEZEL_SYSTEM_SCOPE: '1', GEZEL_SHARED_ASSETS_DIR: shared };

    // Boots rather than throwing, and still reports both moves.
    await expect(migrateLegacySystemModels(home, env)).resolves.toBe(2);

    // The healthy bundle was fully published — hashes backfilled.
    const healthyManifest = JSON.parse(
      await readFile(join(shared, 'models', 'llama-cpp', 'healthy', 'manifest.json'), 'utf8'),
    );
    expect(healthyManifest.fileSha256).toEqual({
      'weights.gguf': createHash('sha256').update('good').digest('hex'),
    });

    // The poisoned bundle still moved; only its permission widening was skipped.
    await expect(
      readFile(join(shared, 'models', 'llama-cpp', 'poisoned', 'weights.gguf'), 'utf8'),
    ).resolves.toBe('also-good');
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
