import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SHARED_ASSETS_ENV } from '../models/storage-roots.js';
import {
  UndeletablePathError,
  assertPathDeletable,
  removeEntry,
  removeGuardedTree,
} from './safe-remove.js';

let home: string;
let outside: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-safe-remove-'));
  outside = await mkdtemp(join(tmpdir(), 'gezel-outside-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

async function seedDir(path: string): Promise<string> {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'payload.bin'), 'x'.repeat(64));
  return path;
}

async function exists(path: string): Promise<boolean> {
  const { access } = await import('node:fs/promises');
  return access(path).then(
    () => true,
    () => false,
  );
}

describe('assertPathDeletable', () => {
  it('accepts an ordinary directory inside the home folder', async () => {
    const dir = await seedDir(join(home, 'engines', 'native-bin'));
    await expect(assertPathDeletable(dir, { home })).resolves.toBeUndefined();
  });

  it('refuses the home directory itself', async () => {
    await expect(assertPathDeletable(home, { home })).rejects.toBeInstanceOf(UndeletablePathError);
  });

  it('refuses a path outside the home folder', async () => {
    const dir = await seedDir(join(outside, 'someones-repo'));
    await expect(assertPathDeletable(dir, { home })).rejects.toThrow(/Outside the Gezel folder/);
  });

  it('refuses a sibling directory that merely shares the name prefix', async () => {
    // `<home>-backup` starts with the home string but is a different folder.
    const sibling = await seedDir(`${home}-backup`);
    try {
      await expect(assertPathDeletable(sibling, { home })).rejects.toBeInstanceOf(
        UndeletablePathError,
      );
    } finally {
      await rm(sibling, { recursive: true, force: true });
    }
  });

  it('refuses a symlink that points out of the home folder', async () => {
    const realTarget = await seedDir(join(outside, 'real-content'));
    const link = join(home, 'engines');
    await mkdir(join(home), { recursive: true });
    await symlink(realTarget, link, 'dir');

    await expect(assertPathDeletable(link, { home })).rejects.toBeInstanceOf(UndeletablePathError);
    expect(await exists(join(realTarget, 'payload.bin'))).toBe(true);
  });

  it('refuses a symlinked location even when it resolves back inside the home folder', async () => {
    // Unlinking would leave the real content on disk while reporting the
    // space as freed, so a link is refused regardless of where it points.
    const real = await seedDir(join(home, 'engines', 'real'));
    const link = join(home, 'engines', 'linked');
    await symlink(real, link, 'dir');

    await expect(assertPathDeletable(link, { home })).rejects.toThrow(/link, not a folder/);
  });

  it('refuses the machine-wide read-only model store', async () => {
    const sharedAssets = await seedDir(join(outside, 'machine-assets'));
    const env = { ...process.env, [SHARED_ASSETS_ENV]: sharedAssets };
    await expect(
      assertPathDeletable(join(sharedAssets, 'models', 'mlx'), { home, env }),
    ).rejects.toThrow(/read-only/);
  });

  it('refuses a relative path outright', async () => {
    await expect(assertPathDeletable('engines/native-bin', { home })).rejects.toThrow(/absolute/);
  });

  it('allows a path that does not exist', async () => {
    // Cleanup resolves categories optimistically; most installs have never
    // created most of them, and removing nothing must not be an error.
    await expect(
      assertPathDeletable(join(home, 'never-created'), { home }),
    ).resolves.toBeUndefined();
  });
});

describe('removeGuardedTree', () => {
  it('removes a directory inside the home folder', async () => {
    const dir = await seedDir(join(home, 'gilde', 'versions'));
    await removeGuardedTree(dir, { home });
    expect(await exists(dir)).toBe(false);
  });

  it('leaves an out-of-home directory completely alone', async () => {
    const dir = await seedDir(join(outside, 'precious'));
    await expect(removeGuardedTree(dir, { home })).rejects.toBeInstanceOf(UndeletablePathError);
    expect(await exists(join(dir, 'payload.bin'))).toBe(true);
  });

  it('treats an already-absent path as done', async () => {
    await expect(removeGuardedTree(join(home, 'gone-already'), { home })).resolves.toBeUndefined();
  });
});

describe('removeEntry', () => {
  it('removes the tracking record alongside the payload it describes', async () => {
    // A surviving record would have the daemon claim an installed toolset
    // whose files are gone — nothing re-installs it, and the break surfaces
    // much later as a missing tool.
    const tree = await seedDir(join(home, 'system-toolsets', 'playwright'));
    const record = join(home, 'system-toolsets.json');
    const roster = join(home, 'installed-toolsets-system.json');
    await writeFile(record, '{"playwright":"1.0.0"}');
    await writeFile(roster, '["playwright"]');

    await removeEntry({ path: tree, external: false, coDelete: [record, roster] }, { home });

    expect(await exists(tree)).toBe(false);
    expect(await exists(record)).toBe(false);
    expect(await exists(roster)).toBe(false);
  });

  it('refuses to co-delete a tracking file outside the home folder', async () => {
    const tree = await seedDir(join(home, 'toolsets'));
    const foreign = join(outside, 'not-ours.json');
    await writeFile(foreign, '{}');

    await removeEntry({ path: tree, external: false, coDelete: [foreign] }, { home });

    expect(await exists(tree)).toBe(false);
    expect(await exists(foreign)).toBe(true);
  });
});
