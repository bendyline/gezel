import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CONTENT_PACK_FILENAME,
  ContentPack,
  collapseToContentPack,
  isContentPackChanged,
  verifyContentPack,
  writeContentPack,
} from './content-pack.js';
import { openContentTree } from './content-tree.js';

const BINARY = Buffer.from(Array.from({ length: 256 }, (_, i) => i));

async function put(root: string, rel: string, data: string | Buffer): Promise<void> {
  const path = join(root, ...rel.split('/'));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
}

async function seedTree(root: string, order: 'forward' | 'reverse' = 'forward'): Promise<void> {
  const files: Array<[string, string | Buffer]> = [
    ['.gitkeep', ''],
    ['toolsets/index.json', '{"kind":"toolset","entries":[]}\n'],
    ['toolsets/aa/aa-tool/manifest.json', '{"id":"aa-tool"}\n'],
    ['toolsets/aa/aa-tool/versions/1.0.0/manifest.json', '{"version":"1.0.0"}\n'],
    ['toolsets/aa/aa-tool/versions/1.0.0/icon.bin', BINARY],
    ['toolsets/aa/aa-tool/readme.md', '\uFEFFlines\nwith a BOM and ünïcödé\n'],
    ['toolsets/aa/aa-tool-2/manifest.json', '{"id":"aa-tool-2"}\n'],
    ['toolsets/aa/aa-toolbox/manifest.json', '{"id":"aa-toolbox"}\n'],
    ['toolsets/ab/ab-tool/manifest.json', '{"id":"ab-tool"}\n'],
    ['toolsets/ab/ab-tool/versions/2.0.0/empty.txt', ''],
  ];
  for (const [rel, data] of order === 'forward' ? files : [...files].reverse()) {
    await put(root, rel, data);
  }
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

describe('content packs', () => {
  let work: string;

  beforeEach(async () => {
    work = await mkdtemp(join(tmpdir(), 'gezel-content-pack-'));
  });

  afterEach(async () => {
    await rm(work, { recursive: true, force: true });
  });

  it('round-trips every file byte for byte, including empty and binary files', async () => {
    const tree = join(work, 'tree');
    await seedTree(tree);
    const packPath = join(work, 'out.pack');
    const written = await writeContentPack(tree, packPath);
    expect(written.files).toBe(10);

    const pack = await ContentPack.open(packPath);
    expect(pack.files()).toEqual([
      '.gitkeep',
      'toolsets/aa/aa-tool-2/manifest.json',
      'toolsets/aa/aa-tool/manifest.json',
      'toolsets/aa/aa-tool/readme.md',
      'toolsets/aa/aa-tool/versions/1.0.0/icon.bin',
      'toolsets/aa/aa-tool/versions/1.0.0/manifest.json',
      'toolsets/aa/aa-toolbox/manifest.json',
      'toolsets/ab/ab-tool/manifest.json',
      'toolsets/ab/ab-tool/versions/2.0.0/empty.txt',
      'toolsets/index.json',
    ]);
    for (const file of pack.files()) {
      const original = await readFile(join(tree, ...file.split('/')));
      expect((await pack.readFile(file)).equals(original)).toBe(true);
    }
    expect(
      (await pack.readFile('toolsets/aa/aa-tool/versions/1.0.0/icon.bin')).equals(BINARY),
    ).toBe(true);
    expect(await verifyContentPack(packPath, tree)).toEqual(written);
  });

  it('is deterministic regardless of the order files were created in', async () => {
    await seedTree(join(work, 'a'), 'forward');
    await seedTree(join(work, 'b'), 'reverse');
    await writeContentPack(join(work, 'a'), join(work, 'a.pack'));
    await writeContentPack(join(work, 'b'), join(work, 'b.pack'));
    expect(sha256(await readFile(join(work, 'a.pack')))).toBe(
      sha256(await readFile(join(work, 'b.pack'))),
    );
  });

  it('answers directory queries with fs-shaped errors', async () => {
    const tree = join(work, 'tree');
    await seedTree(tree);
    await writeContentPack(tree, join(work, 'out.pack'));
    const pack = await ContentPack.open(join(work, 'out.pack'));

    expect(pack.readdir('')).toEqual(['.gitkeep', 'toolsets']);
    expect(pack.readdir('toolsets')).toEqual(['aa', 'ab', 'index.json']);
    expect(pack.readdir('toolsets/aa')).toEqual(['aa-tool', 'aa-tool-2', 'aa-toolbox']);
    expect(pack.readdir('toolsets/aa/aa-tool/versions')).toEqual(['1.0.0']);
    expect(() => pack.readdir('toolsets/index.json')).toThrow(
      expect.objectContaining({ code: 'ENOTDIR' }),
    );
    expect(() => pack.readdir('toolsets/zz')).toThrow(expect.objectContaining({ code: 'ENOENT' }));
    await expect(pack.readFile('toolsets/aa')).rejects.toMatchObject({ code: 'EISDIR' });
    await expect(pack.readFile('toolsets/aa/missing.json')).rejects.toMatchObject({
      code: 'ENOENT',
    });

    // Siblings that extend the name ("aa-tool-2" sorts before "aa-tool/",
    // "aa-toolbox" after it) must not leak into the listing.
    expect(pack.listFiles('toolsets/aa/aa-tool')).toEqual([
      'manifest.json',
      'readme.md',
      'versions/1.0.0/icon.bin',
      'versions/1.0.0/manifest.json',
    ]);
    expect(pack.listFiles('toolsets/ab')).toEqual([
      'ab-tool/manifest.json',
      'ab-tool/versions/2.0.0/empty.txt',
    ]);
    expect(() => pack.listFiles('toolsets/index.json')).toThrow(
      expect.objectContaining({ code: 'ENOTDIR' }),
    );
  });

  it('collapses a directory in place, leaving only the pack', async () => {
    const tree = join(work, 'community');
    await seedTree(tree);
    const originals = new Map<string, Buffer>();
    const pack0 = join(work, 'probe.pack');
    await writeContentPack(tree, pack0);
    for (const file of (await ContentPack.open(pack0)).files()) {
      originals.set(file, await readFile(join(tree, ...file.split('/'))));
    }

    const result = await collapseToContentPack(tree);
    expect(result.files).toBe(10);
    expect(result.packPath).toBe(join(tree, CONTENT_PACK_FILENAME));
    expect(await readdir(tree)).toEqual([CONTENT_PACK_FILENAME]);
    // No staging leftovers beside the directory either.
    expect((await readdir(work)).sort()).toEqual(['community', 'probe.pack']);

    const pack = await ContentPack.open(result.packPath);
    for (const [file, data] of originals) {
      expect((await pack.readFile(file)).equals(data)).toBe(true);
    }
    await expect(collapseToContentPack(tree)).rejects.toThrow(/already packed/);
  });

  it('refuses to pack what it cannot represent, leaving the tree untouched', async () => {
    const tree = join(work, 'tree');
    await seedTree(tree);
    try {
      await symlink(join(tree, '.gitkeep'), join(tree, 'link'));
    } catch {
      return; // symlink creation needs a privilege this Windows account may lack
    }
    await expect(collapseToContentPack(tree)).rejects.toThrow(/not a regular file/);
    expect((await readdir(tree)).sort()).toEqual(['.gitkeep', 'link', 'toolsets']);
    expect((await readdir(work)).sort()).toEqual(['tree']);
  });

  it('rejects truncated and malformed packs', async () => {
    const tree = join(work, 'tree');
    await seedTree(tree);
    const packPath = join(work, 'out.pack');
    await writeContentPack(tree, packPath);
    const size = (await readFile(packPath)).length;
    await truncate(packPath, size - 1);
    await expect(ContentPack.open(packPath)).rejects.toThrow(/not a valid content pack/);

    const bad = join(work, 'bad.pack');
    for (const header of [
      '{"format":"other","version":1,"files":[]}',
      '{"format":"gezel-content-pack","version":2,"files":[]}',
      '{"format":"gezel-content-pack","version":1,"files":[["../escape",0]]}',
      '{"format":"gezel-content-pack","version":1,"files":[["b",0],["a",0]]}',
      '{"format":"gezel-content-pack","version":1,"files":[["a",0],["a",0]]}',
      '{"format":"gezel-content-pack","version":1,"files":[["a",0],["a/b",0]]}',
      'not json',
    ]) {
      await writeFile(bad, `${header}\n`);
      await expect(ContentPack.open(bad)).rejects.toThrow(/not a valid content pack/);
    }
  });

  it('notices a pack replaced after indexing instead of serving stale ranges', async () => {
    const tree = join(work, 'tree');
    await seedTree(tree);
    const packPath = join(work, 'out.pack');
    await writeContentPack(tree, packPath);
    const pack = await ContentPack.open(packPath);

    await put(tree, 'toolsets/aa/aa-tool/manifest.json', '{"id":"aa-tool","renamed":true}\n');
    await rm(packPath);
    await writeContentPack(tree, packPath);

    const error = await pack.readFile('toolsets/aa/aa-tool/manifest.json').catch((err) => err);
    expect(isContentPackChanged(error)).toBe(true);

    // The tree adapter reindexes once and serves the new content.
    const root = join(work, 'root');
    await mkdir(root);
    await writeContentPack(tree, join(root, CONTENT_PACK_FILENAME));
    const reader = await openContentTree(root);
    const manifest = join(root, 'toolsets', 'aa', 'aa-tool', 'manifest.json');
    expect((await reader.readFile(manifest)).toString('utf8')).toContain('renamed');
    await put(tree, 'toolsets/aa/aa-tool/manifest.json', '{"id":"aa-tool","again":1234}\n');
    await rm(join(root, CONTENT_PACK_FILENAME));
    await writeContentPack(tree, join(root, CONTENT_PACK_FILENAME));
    expect((await reader.readFile(manifest)).toString('utf8')).toContain('again');
  });
});

describe('content trees', () => {
  let work: string;

  beforeEach(async () => {
    work = await mkdtemp(join(tmpdir(), 'gezel-content-tree-'));
  });

  afterEach(async () => {
    await rm(work, { recursive: true, force: true });
  });

  it('reads a packed root exclusively through its pack', async () => {
    const root = join(work, 'root');
    await seedTree(root);
    await writeContentPack(root, join(work, 'staged.pack'));
    await writeFile(join(root, CONTENT_PACK_FILENAME), await readFile(join(work, 'staged.pack')));
    // A loose file the pack does not carry stays invisible.
    await put(root, 'toolsets/zz/zz-loose/manifest.json', '{}');

    const tree = await openContentTree(root);
    expect(await tree.readdir(join(root, 'toolsets'))).toEqual(['aa', 'ab', 'index.json']);
    await expect(
      tree.readFile(join(root, 'toolsets', 'zz', 'zz-loose', 'manifest.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    // Paths outside the root are absent, never resolved against the pack.
    await expect(tree.readFile(join(work, 'staged.pack'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect((await tree.listFiles(join(root, 'toolsets', 'ab', 'ab-tool'))).sort()).toEqual([
      'manifest.json',
      'versions/2.0.0/empty.txt',
    ]);
  });

  it('reads an unpacked root from disk', async () => {
    const root = join(work, 'root');
    await seedTree(root);
    const tree = await openContentTree(root);
    expect((await tree.readdir(join(root, 'toolsets'))).sort()).toEqual(['aa', 'ab', 'index.json']);
    expect((await tree.listFiles(join(root, 'toolsets', 'ab', 'ab-tool'))).sort()).toEqual([
      'manifest.json',
      'versions/2.0.0/empty.txt',
    ]);
    await expect(tree.readdir(join(root, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
