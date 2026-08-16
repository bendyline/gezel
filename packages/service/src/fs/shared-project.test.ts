import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SHARED_PROJECT_ID, isSharedLibraryProject } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectDeleteError, Store } from './store.js';

let home: string;
let store: Store;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-shared-'));
  store = new Store({ home });
  await store.ensureLayout();
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('ensureSharedProject', () => {
  it('creates a library project whose workspace is the documents root', async () => {
    const { id, created } = await store.ensureSharedProject();
    expect(created).toBe(true);
    expect(id).toBe(SHARED_PROJECT_ID);

    const project = await store.getProject(id);
    expect(project?.workingDir).toBe(store.documentsDir());
    expect(isSharedLibraryProject(project!)).toBe(true);
    // Written through the document tools, so the external-workingDir gate
    // has to admit them.
    expect(project?.managedWorkspaceWritePolicy).toBe('allow');
    // A library has no lead to recruit; pre-stamping suppresses the
    // first index pass's auto-assign.
    expect(project?.voormanAutoAssignedAt).toBeTruthy();
  });

  it('is idempotent and re-points the workspace when the library moves', async () => {
    const first = await store.ensureSharedProject();
    const moved = new Store({ home, external: { documents: join(home, 'elsewhere') } });
    const second = await moved.ensureSharedProject();

    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
    const project = await moved.getProject(second.id);
    expect(project?.workingDir).toBe(join(home, 'elsewhere'));
  });

  it('seeds one starter document, and never re-creates it after deletion', async () => {
    await store.ensureSharedProject();
    const seeded = await store.listDocuments('');
    expect(seeded).toHaveLength(1);

    for (const entry of seeded) await store.deleteDocument(entry.path);
    await store.ensureSharedProject();
    expect(await store.listDocuments('')).toHaveLength(0);
  });

  it('never adopts a user project that already owns the id', async () => {
    // "Shared" slugifies onto the canonical id. Adopting it would silently
    // repoint the user's workspace at the documents library.
    const mine = await store.createProject({ name: 'Shared' }, { id: SHARED_PROJECT_ID });
    expect(mine.id).toBe(SHARED_PROJECT_ID);

    const { id, created } = await store.ensureSharedProject();
    expect(created).toBe(true);
    expect(id).not.toBe(SHARED_PROJECT_ID);

    const untouched = await store.getProject(SHARED_PROJECT_ID);
    expect(untouched?.name).toBe('Shared');
    expect(untouched?.workingDir).toBeUndefined();
    // The redirect is remembered, so the next boot resolves the same project.
    expect((await store.readConfig()).sharedProjectId).toBe(id);
    expect((await store.ensureSharedProject()).id).toBe(id);
  });

  it('claims a fresh id rather than returning a foreign project at the configured id', async () => {
    // Degenerate state (hand-edited project.json): the id config points at
    // is occupied by something that is not the library. Handing that back
    // would expose a user workspace through the Documents facade.
    await store.writeConfig({ sharedProjectId: 'library-slot' });
    await store.createProject({ name: 'Not the library' }, { id: 'library-slot' });

    const { id, created } = await store.ensureSharedProject();
    expect(created).toBe(true);
    expect(id).not.toBe('library-slot');
    expect(isSharedLibraryProject((await store.getProject(id))!)).toBe(true);
    expect((await store.getProject('library-slot'))?.name).toBe('Not the library');
  });
});

describe('the documents facade', () => {
  it('serves the same directory the library project indexes', async () => {
    // The load-bearing invariant of the whole design: the Documents API and
    // the shared project's workspace are one directory. If these ever
    // diverge, the indexer studies one folder while the API serves another
    // and every downstream surface splits silently.
    const { id } = await store.ensureSharedProject();
    expect(await store.projectWorkspaceDir(id)).toBe(store.documentsDir());
  });

  it('keeps that invariant after the library is relocated', async () => {
    await store.ensureSharedProject();
    const relocated = new Store({ home, external: { documents: join(home, 'onedrive') } });
    const { id } = await relocated.ensureSharedProject();
    expect(await relocated.projectWorkspaceDir(id)).toBe(relocated.documentsDir());
  });

  it('writes a document that the project workspace can read back', async () => {
    const { id } = await store.ensureSharedProject();
    await store.writeDocument('guidelines/tone.md', '# Tone\n\nPlain and warm.');
    const viaWorkspace = await store.readProjectWorkspaceFile(id, 'guidelines/tone.md');
    expect(viaWorkspace).toContain('Plain and warm.');
  });
});

describe('shared library guards', () => {
  it('refuses deletion', async () => {
    const { id } = await store.ensureSharedProject();
    await expect(store.deleteProject(id)).rejects.toThrow(ProjectDeleteError);
  });

  it('refuses a direct workingDir edit, archiving, and a git link', async () => {
    const { id } = await store.ensureSharedProject();
    // The location is derived from the documents root on every boot, so a
    // direct edit here would silently revert.
    await expect(store.updateProject(id, { workingDir: join(home, 'nope') })).rejects.toThrow(
      /Settings/,
    );
    await expect(store.updateProject(id, { archived: true })).rejects.toThrow(/archived/);
    await expect(
      store.updateProject(id, { github: { url: 'https://github.com/o/r' } }),
    ).rejects.toThrow(/git repository/);
    // Ordinary edits still work.
    await expect(store.updateProject(id, { description: 'Our shelf' })).resolves.toBeTruthy();
  });
});
