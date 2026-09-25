import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import { NodePortableFiles, portableStoreOverHome } from './portable-node-files.js';

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-portable-node-files-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('NodePortableFiles', () => {
  it('round-trips bytes and lists entries with sizes', async () => {
    const files = new NodePortableFiles(home);
    await files.mkdir('a/b');
    await files.write('a/b/c.txt', new TextEncoder().encode('hello'));
    expect(new TextDecoder().decode((await files.read('a/b/c.txt'))!)).toBe('hello');
    expect(await files.read('a/missing')).toBeNull();
    const listed = await files.list('a/b');
    expect(listed).toEqual([
      expect.objectContaining({ name: 'c.txt', isDirectory: false, size: 5 }),
    ]);
    expect(await files.list('nowhere')).toEqual([]);
    await expect(files.rename('a/b/c.txt', 'a/b/c.txt')).rejects.toThrow(/Refusing/);
    await files.remove('a');
    expect(await files.list('a')).toEqual([]);
  });
});

describe('portableStoreOverHome', () => {
  it('reads a home the desktop store wrote', async () => {
    const desktop = new Store({ home });
    await desktop.ensureLayout();
    const created = await desktop.createProject({ name: 'Default' });
    const portable = portableStoreOverHome(home);
    expect(await portable.readConfig()).toBeTruthy();
    const project = await portable.getProject(created.id);
    expect(project?.id).toBe(created.id);
    expect(project?.name).toBe('Default');
  });
});
