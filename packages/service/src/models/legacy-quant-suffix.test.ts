import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateLegacyQuantSuffixIds, remapEngineScopedKeys } from './legacy-quant-suffix.js';
import { findRenamedModelId } from './storage-roots.js';

let root: string;
let readOnlyRoot: string;

const roots = () => ({ writableRoot: root, readOnlyRoots: [readOnlyRoot] });

async function seed(
  where: string,
  id: string,
  manifest: Record<string, unknown> | null,
): Promise<void> {
  await mkdir(join(where, id), { recursive: true });
  await writeFile(join(where, id, 'weights.gguf'), 'weights');
  if (manifest) {
    await writeFile(join(where, id, 'manifest.json'), JSON.stringify(manifest, null, 2));
  }
}

const install = (id: string, quantization: string) => ({
  id,
  name: 'Test model',
  approxSizeBytes: 7,
  weightsFilename: 'weights.gguf',
  installedAt: '2026-01-01T00:00:00.000Z',
  catalogId: id,
  quantization,
});

beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), 'gezel-quant-suffix-'));
  root = join(base, 'writable');
  readOnlyRoot = join(base, 'machine');
  await mkdir(root, { recursive: true });
  await mkdir(readOnlyRoot, { recursive: true });
});

afterEach(async () => {
  await rm(join(root, '..'), { recursive: true, force: true });
});

describe('migrateLegacyQuantSuffixIds', () => {
  it('renames to the current catalog id when the alias map knows one', async () => {
    await seed(root, 'mistral', install('mistral', 'Q4_K_M'));

    const renames = await migrateLegacyQuantSuffixIds({ roots: roots(), engine: 'llama-cpp' });

    expect(renames).toEqual([{ engine: 'llama-cpp', from: 'mistral', to: 'mistral-7b-q4' }]);
    expect(await readdir(root)).toEqual(['mistral-7b-q4']);
    const manifest = JSON.parse(
      await readFile(join(root, 'mistral-7b-q4', 'manifest.json'), 'utf8'),
    );
    expect(manifest.id).toBe('mistral-7b-q4');
    expect(manifest.renamedFrom).toBe('mistral');
  });

  // The catalog only ever published E4B at Q4, so the Q8 install has no id to
  // re-link to — but `catalogId` must survive untouched either way, because
  // repointing it is what would move the model onto another build's tuning.
  it('derives the suffix, and never repoints catalogId, when no catalog id exists', async () => {
    await seed(root, 'gemma4-e4b', install('gemma4-e4b', 'Q8_0'));

    const renames = await migrateLegacyQuantSuffixIds({ roots: roots(), engine: 'llama-cpp' });

    expect(renames).toEqual([{ engine: 'llama-cpp', from: 'gemma4-e4b', to: 'gemma4-e4b-q8' }]);
    const manifest = JSON.parse(
      await readFile(join(root, 'gemma4-e4b-q8', 'manifest.json'), 'utf8'),
    );
    expect(manifest.catalogId).toBe('gemma4-e4b');
  });

  it('leaves already-suffixed installs alone', async () => {
    await seed(root, 'gemma4-e4b-q4', install('gemma4-e4b-q4', 'UD-Q4_K_XL'));

    expect(await migrateLegacyQuantSuffixIds({ roots: roots(), engine: 'llama-cpp' })).toEqual([]);
    expect(await readdir(root)).toEqual(['gemma4-e4b-q4']);
  });

  it('leaves an install alone when no label names a width', async () => {
    await seed(root, 'muse-glimmer', install('muse-glimmer', 'K-Quant-17GB'));

    expect(await migrateLegacyQuantSuffixIds({ roots: roots(), engine: 'llama-cpp' })).toEqual([]);
    expect(await readdir(root)).toEqual(['muse-glimmer']);
  });

  // A rename onto an id a read-only machine model already owns would leave
  // the local copy resolving to neither name.
  it('refuses a rename that collides with a model in any overlay root', async () => {
    await seed(root, 'qwen3.5-9b', install('qwen3.5-9b', 'Q4_K_M'));
    await seed(readOnlyRoot, 'qwen3.5-9b-q4', install('qwen3.5-9b-q4', 'Q4_K_M'));

    expect(await migrateLegacyQuantSuffixIds({ roots: roots(), engine: 'llama-cpp' })).toEqual([]);
    expect(await readdir(root)).toEqual(['qwen3.5-9b']);
  });

  it('never renames a model in a read-only root', async () => {
    await seed(readOnlyRoot, 'mistral', install('mistral', 'Q4_K_M'));

    expect(await migrateLegacyQuantSuffixIds({ roots: roots(), engine: 'llama-cpp' })).toEqual([]);
    expect(await readdir(readOnlyRoot)).toEqual(['mistral']);
  });

  it('skips publish backups and manifestless download directories', async () => {
    await seed(root, '.mistral.gezmodel-backup-1', install('mistral', 'Q4_K_M'));
    await seed(root, 'qwen3.5-9b', null);

    expect(await migrateLegacyQuantSuffixIds({ roots: roots(), engine: 'llama-cpp' })).toEqual([]);
    expect((await readdir(root)).sort()).toEqual(['.mistral.gezmodel-backup-1', 'qwen3.5-9b']);
  });

  it('is idempotent across boots', async () => {
    await seed(root, 'mistral', install('mistral', 'Q4_K_M'));

    await migrateLegacyQuantSuffixIds({ roots: roots(), engine: 'llama-cpp' });
    expect(await migrateLegacyQuantSuffixIds({ roots: roots(), engine: 'llama-cpp' })).toEqual([]);
  });
});

describe('findRenamedModelId', () => {
  it('resolves a pin written against the id the install used to carry', async () => {
    await seed(root, 'mistral', install('mistral', 'Q4_K_M'));
    await migrateLegacyQuantSuffixIds({ roots: roots(), engine: 'llama-cpp' });

    expect(await findRenamedModelId(roots(), 'mistral')).toBe('mistral-7b-q4');
    expect(await findRenamedModelId(roots(), 'qwen3.5-9b')).toBeNull();
  });
});

describe('remapEngineScopedKeys', () => {
  const renames = [{ engine: 'llama-cpp', from: 'mistral', to: 'mistral-7b-q4' }];

  it('moves only the keys scoped to the renamed engine', () => {
    expect(
      remapEngineScopedKeys(
        { 'llama-cpp:mistral': 8192, 'mlx:mistral': 4096, 'llama-cpp:other': 2048 },
        renames,
      ),
    ).toEqual({ 'llama-cpp:mistral-7b-q4': 8192, 'mlx:mistral': 4096, 'llama-cpp:other': 2048 });
  });

  it('keeps an existing record for the new id rather than overwriting it', () => {
    expect(
      remapEngineScopedKeys({ 'llama-cpp:mistral': 1, 'llama-cpp:mistral-7b-q4': 2 }, renames),
    ).toEqual({ 'llama-cpp:mistral': 1, 'llama-cpp:mistral-7b-q4': 2 });
  });

  it('returns the same object when nothing moved, so the caller can skip the write', () => {
    const record = { 'llama-cpp:other': 1 };
    expect(remapEngineScopedKeys(record, renames)).toBe(record);
    expect(remapEngineScopedKeys(record, [])).toBe(record);
    expect(remapEngineScopedKeys(undefined, renames)).toBeUndefined();
  });
});
