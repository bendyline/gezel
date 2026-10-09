import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { treeIdentity } from './metadata.ts';

let dir: string;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('measurement identity', () => {
  it('hashes filenames and contents deterministically, rather than mtimes or file counts', async () => {
    dir = await mkdtemp(join(tmpdir(), 'qualification-identity-'));
    await mkdir(join(dir, 'nested'));
    await writeFile(join(dir, 'b'), 'same size');
    await writeFile(join(dir, 'nested', 'a'), 'fixture');
    const first = await treeIdentity(dir);
    expect(first.files).toBe(2);
    await writeFile(join(dir, 'b'), 'same size');
    expect(await treeIdentity(dir)).toEqual(first);
    await writeFile(join(dir, 'b'), 'new bytes');
    expect((await treeIdentity(dir)).sha256).not.toBe(first.sha256);
  });
});
