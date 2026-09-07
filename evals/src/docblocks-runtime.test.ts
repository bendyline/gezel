import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sharedToolsetsFile } from '@bendyline/gezel/paths';
import { afterEach, describe, expect, it } from 'vitest';
import { seedDocblocksRuntime } from './docblocks-runtime.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(name = '@bendyline/docblocks-cli') {
  const root = await mkdtemp(join(tmpdir(), 'docblocks-runtime-test-'));
  roots.push(root);
  const home = join(root, 'home');
  const pkg = join(root, 'cli');
  await mkdir(home);
  await mkdir(join(pkg, 'dist'), { recursive: true });
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ name, version: '2.6.0-local' }));
  return { home, pkg };
}

describe('local DocBlocks eval runtime', () => {
  it('records the actual build and preserves unrelated toolsets', async () => {
    const { home, pkg } = await fixture();
    const entry = 'console.log("local CLI fixture");';
    await writeFile(join(pkg, 'dist/bin.js'), entry);
    const other = { toolsetId: 'other', installPath: '/keep/this' };
    const roster = sharedToolsetsFile(home);
    await writeFile(
      roster,
      JSON.stringify([other, { toolsetId: 'docblocks', installPath: '/old' }]),
    );
    const provenance = await seedDocblocksRuntime(home, pkg, () => {});
    expect(provenance.packageVersion).toBe('2.6.0-local');
    expect(provenance.entrySha256).toBe(createHash('sha256').update(entry).digest('hex'));
    expect(JSON.parse(await readFile(roster, 'utf8'))).toEqual([
      other,
      expect.objectContaining({ toolsetId: 'docblocks', installPath: provenance.installPath }),
    ]);
    expect(
      JSON.parse(await readFile(join(home, 'docblocks-eval-provenance.json'), 'utf8')),
    ).toEqual(provenance);
  });

  it('rejects the wrong package or an unbuilt CLI before changing the install roster', async () => {
    const wrong = await fixture('not-docblocks');
    await expect(seedDocblocksRuntime(wrong.home, wrong.pkg, () => {})).rejects.toThrow(
      'must name',
    );
    const unbuilt = await fixture();
    await expect(seedDocblocksRuntime(unbuilt.home, unbuilt.pkg, () => {})).rejects.toThrow(
      'ENOENT',
    );
    await expect(readFile(sharedToolsetsFile(unbuilt.home))).rejects.toThrow('ENOENT');
  });
});
