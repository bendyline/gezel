import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connectionDataTargets, deleteTargets, measureTargets } from './remove-data.js';

let root: string;
let artifactsDir: string;
let quarantineDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gezel-remove-data-'));
  artifactsDir = join(root, 'artifacts');
  quarantineDir = join(root, 'quarantine');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function put(path: string, text: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, text);
}

/** A corpus holding one ordinary record and one held in quarantine. */
async function corpus(name: string, held: string): Promise<void> {
  const dir = join(artifactsDir, 'data', name, 'inbox', 'thread');
  await put(join(dir, '001-hello.md'), 'hello');
  await put(join(dir, '002-held.md'), 'held stub');
  await put(join(dir, '_flags.json'), JSON.stringify({ '0a0b0c0d': {}, [held]: {} }));
  await put(join(quarantineDir, 'mail-test', `${held}.md`), 'the held body');
  await put(join(quarantineDir, 'mail-test', 'attachments', held, 'a.pdf'), 'pdf');
}

const where = (corpusDir: string, extra: Partial<Parameters<typeof connectionDataTargets>[0]>) => ({
  artifactsDir,
  quarantineDir,
  corpusDir,
  type: 'mail-test',
  otherCorpusDirs: [],
  typeShared: false,
  ...extra,
});

describe('what a connection downloaded', () => {
  it('is its corpus folder and, when no other connection shares its type, the type’s quarantine', async () => {
    await corpus('a', '11111111');
    const targets = await connectionDataTargets(where('data/a', {}));
    expect(targets).toEqual([join(artifactsDir, 'data/a'), join(quarantineDir, 'mail-test')]);
    const flags = JSON.stringify({ '0a0b0c0d': {}, '11111111': {} }).length;
    expect(await measureTargets(targets)).toEqual({ files: 5, bytes: 5 + 9 + flags + 13 + 3 });
  });

  it('takes only its own held records when another connection of the type remains', async () => {
    await corpus('a', '11111111');
    await corpus('b', '22222222');
    const targets = await connectionDataTargets(
      where('data/a', { otherCorpusDirs: ['data/b'], typeShared: true }),
    );
    expect(targets).toEqual([
      join(artifactsDir, 'data/a'),
      join(quarantineDir, 'mail-test', '11111111.md'),
      join(quarantineDir, 'mail-test', 'attachments', '11111111'),
    ]);
    await deleteTargets(targets);
    expect(await readdir(join(artifactsDir, 'data'))).toEqual(['b']);
    expect((await readdir(join(quarantineDir, 'mail-test'))).sort()).toEqual([
      '22222222.md',
      'attachments',
    ]);
    expect(await readdir(join(quarantineDir, 'mail-test', 'attachments'))).toEqual(['22222222']);
  });

  it('is nothing when nothing was downloaded', async () => {
    expect(await connectionDataTargets(where('data/empty', {}))).toEqual([]);
    expect(await measureTargets([])).toEqual({ files: 0, bytes: 0 });
  });

  it('refuses a folder another connection saves into, or one that is not a connection’s', async () => {
    await corpus('a', '11111111');
    await expect(
      connectionDataTargets(where('data/a', { otherCorpusDirs: ['data/a'] })),
    ).rejects.toThrow(/Another connection saves into data\/a/);
    await expect(
      connectionDataTargets(where('data/a', { otherCorpusDirs: ['data/a/inbox'] })),
    ).rejects.toThrow(/Another connection/);
    for (const bad of ['data', 'data/', 'reports/x', 'data/../reports', '../data/a']) {
      await expect(connectionDataTargets(where(bad, {}))).rejects.toThrow(/not a connection/);
    }
    await expect(connectionDataTargets(where('data/a', { type: '../x' }))).rejects.toThrow(
      /unexpected connector type/,
    );
  });
});
