import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import type { TaskManager } from '../tasks/manager.js';
import { DiffpackDriftedError, DiffpackManager } from './manager.js';

let home: string;
let folder: string;
let store: Store;
let manager: DiffpackManager;
let projectId: string;

const fakeTasks = {
  getByRef: async () => null as Task | null,
} as unknown as TaskManager;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-diffpack-ops-'));
  folder = join(home, 'Pictures');
  await mkdir(join(folder, 'Camera'), { recursive: true });
  await writeFile(join(folder, 'Camera', 'IMG_0001.jpg'), 'beach');
  await writeFile(join(folder, 'Camera', 'IMG_0002.jpg'), 'birthday');
  await writeFile(join(folder, 'notes.txt'), 'old notes\n');
  store = new Store({ home });
  await store.ensureLayout();
  // An added folder: external, read-only for gezels.
  const project = await store.createProject({ name: 'Pictures', workingDir: folder });
  projectId = project.id;
  manager = new DiffpackManager({ home, store, tasks: fakeTasks });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function draft(packId: string, edits: (d: DiffpackManager['drafts']) => Promise<void>) {
  await manager.ensure(projectId, packId, {
    title: 'Tidy the camera roll',
    origin: { kind: 'manual' },
    taskRef: `${projectId}/${packId}`,
  });
  await edits(manager.drafts);
  return manager.seal(projectId, packId);
}

describe('file operations in a change proposal', () => {
  it('seals moves, copies and new folders after the edits, and leaves the folder alone', async () => {
    const sealed = await draft('4', async (d) => {
      await d.write(projectId, '4', 'notes.txt', 'tidied notes\n');
      await d.proposeOperation(projectId, '4', { op: 'mkdir', to: 'Albums/Beach' });
      await d.proposeOperation(projectId, '4', {
        op: 'copy',
        from: 'Camera/IMG_0001.jpg',
        to: 'Albums/Beach/IMG_0001.jpg',
      });
      await d.proposeOperation(projectId, '4', {
        op: 'move',
        from: 'Camera/IMG_0002.jpg',
        to: 'Birthday/IMG_0002.jpg',
      });
    });

    expect(sealed.status).toBe('ready');
    expect(sealed.files.map((f) => [f.change, f.from ?? null, f.path])).toEqual([
      ['modify', null, 'notes.txt'],
      ['mkdir', null, 'Albums/Beach'],
      ['copy', 'Camera/IMG_0001.jpg', 'Albums/Beach/IMG_0001.jpg'],
      ['move', 'Camera/IMG_0002.jpg', 'Birthday/IMG_0002.jpg'],
    ]);
    expect((await readdir(folder)).sort()).toEqual(['Camera', 'notes.txt']);
  });

  it('applies them into a folder gezels cannot write, as the person', async () => {
    await draft('5', async (d) => {
      await d.proposeOperation(projectId, '5', {
        op: 'copy',
        from: 'Camera/IMG_0001.jpg',
        to: 'Albums/Beach/IMG_0001.jpg',
      });
      await d.proposeOperation(projectId, '5', {
        op: 'move',
        from: 'Camera/IMG_0002.jpg',
        to: 'Birthday/IMG_0002.jpg',
      });
      await d.proposeOperation(projectId, '5', { op: 'mkdir', to: 'Later' });
    });
    await expect(
      store.mkdirProjectWorkspace(projectId, 'Sneaky', { gezelId: 'dev' }),
    ).rejects.toThrow();

    const res = await manager.apply(projectId, '5');

    expect(res.ok).toBe(true);
    expect(await readFile(join(folder, 'Albums/Beach/IMG_0001.jpg'), 'utf8')).toBe('beach');
    expect(await readFile(join(folder, 'Camera/IMG_0001.jpg'), 'utf8')).toBe('beach');
    expect(await readFile(join(folder, 'Birthday/IMG_0002.jpg'), 'utf8')).toBe('birthday');
    await expect(stat(join(folder, 'Camera/IMG_0002.jpg'))).rejects.toThrow();
    expect((await stat(join(folder, 'Later'))).isDirectory()).toBe(true);
    expect((await manager.get(projectId, '5')).status).toBe('applied');
  });

  it('refuses a destination that is taken, a missing source, or a folder into itself', async () => {
    await manager.ensure(projectId, '6', {
      title: 'Bad moves',
      origin: { kind: 'manual' },
      taskRef: `${projectId}/6`,
    });
    const d = manager.drafts;
    await expect(
      d.proposeOperation(projectId, '6', {
        op: 'move',
        from: 'Camera/IMG_0001.jpg',
        to: 'notes.txt',
      }),
    ).rejects.toThrow(/already exists/);
    await expect(
      d.proposeOperation(projectId, '6', { op: 'copy', from: 'Camera/nope.jpg', to: 'x.jpg' }),
    ).rejects.toThrow(/no such file/);
    await expect(
      d.proposeOperation(projectId, '6', { op: 'move', from: 'Camera', to: 'Camera/Inner' }),
    ).rejects.toThrow(/into itself/);
    await d.proposeOperation(projectId, '6', { op: 'copy', from: 'notes.txt', to: 'copy.txt' });
    await expect(
      d.proposeOperation(projectId, '6', { op: 'copy', from: 'notes.txt', to: 'copy.txt' }),
    ).rejects.toThrow(/already puts something there/);
    await expect(d.write(projectId, '6', 'copy.txt', 'edit at the target')).rejects.toThrow(
      /where a proposed copy lands/,
    );
  });

  it('calls it drift when someone puts a file where a move would land, and never replaces it', async () => {
    await draft('7', async (d) => {
      await d.proposeOperation(projectId, '7', {
        op: 'move',
        from: 'Camera/IMG_0001.jpg',
        to: 'Beach.jpg',
      });
    });
    await writeFile(join(folder, 'Beach.jpg'), 'someone else');

    expect((await manager.get(projectId, '7')).drifted).toEqual(['Beach.jpg']);
    await expect(manager.apply(projectId, '7')).rejects.toBeInstanceOf(DiffpackDriftedError);
    const forced = await manager.apply(projectId, '7', { allowDrifted: true });

    expect(forced.ok).toBe(false);
    expect(await readFile(join(folder, 'Beach.jpg'), 'utf8')).toBe('someone else');
    expect(await readFile(join(folder, 'Camera/IMG_0001.jpg'), 'utf8')).toBe('beach');
  });

  it('counts a proposal of only file operations as a proposal', async () => {
    const sealed = await draft('8', async (d) => {
      await d.proposeOperation(projectId, '8', { op: 'mkdir', to: 'Albums' });
    });
    expect(sealed.status).toBe('ready');
    expect(await manager.drafts.isEmpty(projectId, '8')).toBe(false);
  });
});
