import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { Store } from './store.js';

it.each(['artifacts', 'documents', 'workspace'] as const)(
  '%s mutations stay inside their root',
  async (kind) => {
    const fixture = await mkdtemp(join(tmpdir(), 'gezel-mutation-containment-'));
    try {
      const store = new Store({ home: join(fixture, 'home') });
      await store.ensureLayout();
      const project = await store.createProject({ name: 'Containment' });
      const base =
        kind === 'artifacts'
          ? store.projectArtifactsDir(project.id)
          : kind === 'workspace'
            ? await store.projectWorkspaceDir(project.id)
            : store.documentsDir();
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
          : kind === 'documents'
            ? {
                text: () => store.writeDocument('linked/keep.txt', 'changed'),
                binary: () =>
                  store.writeDocumentBinary('linked/new/file.bin', Buffer.from('changed')),
                delete: () => store.deleteDocument('linked/keep.txt'),
                mkdir: () => store.createDocumentFolder('linked/new/folder'),
                moveOut: () => store.renameDocument('local.txt', 'linked/moved.txt'),
                moveIn: () => store.renameDocument('linked/keep.txt', 'moved.txt'),
              }
            : {
                text: () =>
                  store.writeProjectWorkspaceFile(project.id, 'linked/keep.txt', 'changed'),
                binary: () =>
                  store.writeProjectWorkspaceBinary(
                    project.id,
                    'linked/new/file.bin',
                    Buffer.from('changed'),
                  ),
                delete: () => store.rmProjectWorkspacePath(project.id, 'linked/keep.txt'),
                mkdir: () => store.mkdirProjectWorkspace(project.id, 'linked/new/folder'),
                moveOut: () =>
                  store.renameProjectWorkspacePath(project.id, 'local.txt', 'linked/moved.txt'),
                moveIn: () =>
                  store.renameProjectWorkspacePath(project.id, 'linked/keep.txt', 'moved.txt'),
                copy: async () => {
                  await store.writeProjectArtifact(project.id, 'source.txt', 'copy');
                  await store.copyProjectArtifactToWorkspace(
                    project.id,
                    'source.txt',
                    'linked/new/copy.txt',
                  );
                },
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

it.each(['artifacts', 'documents', 'workspace'] as const)(
  '%s supports missing parents but rejects root mutations',
  async (kind) => {
    const fixture = await mkdtemp(join(tmpdir(), 'gezel-mutation-sequence-'));
    try {
      const store = new Store({ home: fixture });
      await store.ensureLayout();
      const project = await store.createProject({ name: 'Sequence' });
      const owner =
        kind === 'artifacts'
          ? {
              base: store.projectArtifactsDir(project.id),
              text: (path: string, text: string) =>
                store.writeProjectArtifact(project.id, path, text),
              binary: (path: string, bytes: Buffer) =>
                store.writeProjectArtifactBinary(project.id, path, bytes),
              rename: (from: string, to: string) =>
                store.renameProjectArtifactPath(project.id, from, to),
              delete: (path: string) => store.deleteProjectArtifact(project.id, path),
            }
          : kind === 'documents'
            ? {
                base: store.documentsDir(),
                text: (path: string, text: string) => store.writeDocument(path, text),
                binary: (path: string, bytes: Buffer) => store.writeDocumentBinary(path, bytes),
                rename: (from: string, to: string) => store.renameDocument(from, to),
                delete: (path: string) => store.deleteDocument(path),
              }
            : {
                base: await store.projectWorkspaceDir(project.id),
                text: (path: string, text: string) =>
                  store.writeProjectWorkspaceFile(project.id, path, text),
                binary: (path: string, bytes: Buffer) =>
                  store.writeProjectWorkspaceBinary(project.id, path, bytes),
                rename: (from: string, to: string) =>
                  store.renameProjectWorkspacePath(project.id, from, to),
                delete: (path: string) =>
                  store.rmProjectWorkspacePath(project.id, path, { recursive: true }),
              };
      const bytes = Buffer.from([0, 255, 128, 10]);
      await owner.text('new/notes.txt', 'text');
      await owner.binary('new/bytes.bin', bytes);
      await owner.rename('new/bytes.bin', 'missing/parent/moved.bin');
      expect(await readFile(join(owner.base, 'missing/parent/moved.bin'))).toEqual(bytes);
      await owner.delete('missing/parent/moved.bin');
      await expect(readFile(join(owner.base, 'missing/parent/moved.bin'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      for (const root of ['.', 'new/..']) {
        for (const mutate of [
          () => owner.delete(root),
          () => owner.text(root, 'overwrite root'),
          () => owner.binary(root, bytes),
          () => owner.rename('new/notes.txt', root),
          () => owner.rename(root, 'moved-root'),
        ]) {
          await expect(mutate(), root).rejects.toMatchObject({
            code: expect.stringMatching(/^(empty-path|artifact-root)$/),
          });
          expect(await readFile(join(owner.base, 'new/notes.txt'), 'utf8')).toBe('text');
        }
      }
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  },
);
