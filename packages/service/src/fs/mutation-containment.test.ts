import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { Store } from './store.js';

it.each(['artifacts', 'documents'] as const)(
  '%s mutations stay inside their root',
  async (kind) => {
    const fixture = await mkdtemp(join(tmpdir(), 'gezel-mutation-containment-'));
    try {
      const store = new Store({ home: join(fixture, 'home') });
      await store.ensureLayout();
      const project = await store.createProject({ name: 'Containment' });
      const base =
        kind === 'artifacts' ? store.projectArtifactsDir(project.id) : store.documentsDir();
      const outside = join(fixture, 'outside');
      await mkdir(base, { recursive: true });
      await mkdir(outside);
      await writeFile(join(outside, 'keep.txt'), 'outside work');
      await writeFile(join(base, 'local.txt'), 'local work');
      await symlink(
        outside,
        join(base, 'linked'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      const operations =
        kind === 'artifacts'
          ? {
              text: () => store.writeProjectArtifact(project.id, 'linked/keep.txt', 'changed'),
              binary: () =>
                store.writeProjectArtifactBinary(
                  project.id,
                  'linked/new/file.bin',
                  Buffer.from('changed'),
                ),
              delete: () => store.deleteProjectArtifact(project.id, 'linked/keep.txt'),
              mkdir: () => store.createProjectArtifactFolder(project.id, 'linked/new/folder'),
              moveOut: () =>
                store.renameProjectArtifactPath(project.id, 'local.txt', 'linked/moved.txt'),
              moveIn: () =>
                store.renameProjectArtifactPath(project.id, 'linked/keep.txt', 'moved.txt'),
            }
          : {
              text: () => store.writeDocument('linked/keep.txt', 'changed'),
              binary: () =>
                store.writeDocumentBinary('linked/new/file.bin', Buffer.from('changed')),
              delete: () => store.deleteDocument('linked/keep.txt'),
              mkdir: () => store.createDocumentFolder('linked/new/folder'),
              moveOut: () => store.renameDocument('local.txt', 'linked/moved.txt'),
              moveIn: () => store.renameDocument('linked/keep.txt', 'moved.txt'),
            };
      for (const [name, mutate] of Object.entries(operations)) {
        await expect(mutate(), name).rejects.toMatchObject({ code: 'symlink-escape' });
      }
      expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('outside work');
      expect(await readFile(join(base, 'local.txt'), 'utf8')).toBe('local work');
      await expect(readFile(join(outside, 'new/file.bin'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await rm(join(base, 'linked'));
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  },
);
