import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import { WorkspaceEditError } from '../workspace/errors.js';
import { DiffpackDraftStore } from './draft-store.js';

let home: string;
let store: Store;
let drafts: DiffpackDraftStore;
const projectId = 'draft-fixture';
const packId = '7';

async function seedWorkspace(rel: string, content: string): Promise<void> {
  const wd = await store.projectWorkspaceDir(projectId);
  const full = join(wd, rel);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, content, 'utf8');
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-diffpack-draft-test-'));
  store = new Store({ home });
  await store.ensureLayout();
  await mkdir(await store.projectWorkspaceDir(projectId), { recursive: true });
  drafts = new DiffpackDraftStore(store);
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('DiffpackDraftStore reads', () => {
  it('falls through to the workspace until the pack has its own copy', async () => {
    await seedWorkspace('src/a.ts', 'export const a = 1;\n');
    expect(await drafts.read(projectId, packId, 'src/a.ts')).toBe('export const a = 1;\n');

    await drafts.replaceIn(projectId, packId, {
      path: 'src/a.ts',
      find: 'a = 1',
      replace: 'a = 2',
    });

    expect(await drafts.read(projectId, packId, 'src/a.ts')).toBe('export const a = 2;\n');
  });

  it('returns null for a file that exists nowhere', async () => {
    expect(await drafts.read(projectId, packId, 'nope.ts')).toBeNull();
  });

  it('keeps two packs isolated from each other', async () => {
    await seedWorkspace('src/a.ts', 'value = 0\n');
    await drafts.replaceIn(projectId, '1', { path: 'src/a.ts', find: '0', replace: '1' });
    await drafts.replaceIn(projectId, '2', { path: 'src/a.ts', find: '0', replace: '2' });

    expect(await drafts.read(projectId, '1', 'src/a.ts')).toBe('value = 1\n');
    expect(await drafts.read(projectId, '2', 'src/a.ts')).toBe('value = 2\n');
  });
});

describe('DiffpackDraftStore never touches the workspace', () => {
  it('leaves the workspace file byte-identical after every edit shape', async () => {
    const original = 'line one\nline two\nline three\n';
    await seedWorkspace('src/a.ts', original);

    await drafts.replaceIn(projectId, packId, {
      path: 'src/a.ts',
      find: 'line one',
      replace: 'LINE ONE',
    });
    await drafts.replaceLines(projectId, packId, {
      path: 'src/a.ts',
      startLine: 2,
      endLine: 2,
      content: 'LINE TWO',
    });
    await drafts.insertAtMarker(projectId, packId, {
      path: 'src/a.ts',
      marker: 'line three',
      content: '\nline four',
    });
    await drafts.write(projectId, packId, 'src/new.ts', 'brand new\n');
    await drafts.delete(projectId, packId, 'src/a.ts');

    expect(await store.readProjectWorkspaceFile(projectId, 'src/a.ts')).toBe(original);
    expect(await store.readProjectWorkspaceFile(projectId, 'src/new.ts')).toBeNull();
  });

  it('drafts against a workspace the project has no write grant for', async () => {
    const external = join(home, 'external-checkout');
    await mkdir(external, { recursive: true });
    await writeFile(join(external, 'a.ts'), 'const a = 1;\n', 'utf8');
    const project = await store.createProject({ name: 'External', workingDir: external });

    // The gate the workspace path would hit: an external workingDir with no
    // managed-write grant is exactly the case diffpacks exist for.
    const gate = await store.assertWorkspaceWritable(project.id, { initiatedByGezel: true });
    expect(gate.ok).toBe(false);

    const result = await drafts.replaceIn(project.id, packId, {
      path: 'a.ts',
      find: 'a = 1',
      replace: 'a = 2',
    });
    expect(result.addedLines).toBe(1);
    expect(await drafts.read(project.id, packId, 'a.ts')).toBe('const a = 2;\n');
  });
});

describe('DiffpackDraftStore edit semantics', () => {
  it('reuses the workspace whitespace-flexible fallback', async () => {
    await seedWorkspace('src/a.ts', 'function f() {\n    return 1;\n}\n');
    // Wrong indentation and a pasted read_file gutter — both tolerated.
    await drafts.replaceIn(projectId, packId, {
      path: 'src/a.ts',
      find: '  2→return 1;',
      replace: '    return 2;',
    });
    expect(await drafts.read(projectId, packId, 'src/a.ts')).toBe(
      'function f() {\n    return 2;\n}\n',
    );
  });

  it('rejects an identity edit with the same error the workspace path uses', async () => {
    await seedWorkspace('src/a.ts', 'same\n');
    await expect(
      drafts.replaceIn(projectId, packId, { path: 'src/a.ts', find: 'same', replace: 'same' }),
    ).rejects.toThrow(WorkspaceEditError);
  });

  it('points a model at write_file when editing a file that does not exist', async () => {
    await expect(
      drafts.replaceIn(projectId, packId, { path: 'gone.ts', find: 'a', replace: 'b' }),
    ).rejects.toThrow(/use `write_file` to create it first/i);
  });

  it('creates net-new files through write', async () => {
    const result = await drafts.write(projectId, packId, 'src/new.ts', 'hello\n');
    expect(result.removedLines).toBe(0);
    expect(await drafts.listDraftedPaths(projectId, packId)).toEqual(['src/new.ts']);
  });
});

describe('DiffpackDraftStore deletions', () => {
  it('tombstones a workspace file rather than removing it', async () => {
    await seedWorkspace('src/dead.ts', 'unused\n');
    await drafts.delete(projectId, packId, 'src/dead.ts');

    expect(await drafts.listDeletions(projectId, packId)).toEqual(['src/dead.ts']);
    expect(await drafts.read(projectId, packId, 'src/dead.ts')).toBeNull();
    expect(await store.readProjectWorkspaceFile(projectId, 'src/dead.ts')).toBe('unused\n');
  });

  it('refuses to tombstone a path that exists nowhere', async () => {
    await expect(drafts.delete(projectId, packId, 'ghost.ts')).rejects.toThrow(/no such file/i);
  });

  it('drops a file the pack itself created instead of tombstoning it', async () => {
    await drafts.write(projectId, packId, 'src/temp.ts', 'scratch\n');
    await drafts.delete(projectId, packId, 'src/temp.ts');

    expect(await drafts.listDeletions(projectId, packId)).toEqual([]);
    expect(await drafts.listDraftedPaths(projectId, packId)).toEqual([]);
  });

  it('clears the tombstone when the path is written again', async () => {
    await seedWorkspace('src/a.ts', 'old\n');
    await drafts.delete(projectId, packId, 'src/a.ts');
    await drafts.write(projectId, packId, 'src/a.ts', 'new\n');

    expect(await drafts.listDeletions(projectId, packId)).toEqual([]);
    expect(await drafts.read(projectId, packId, 'src/a.ts')).toBe('new\n');
  });
});

describe('DiffpackDraftStore.isEmpty', () => {
  it('is empty with no drafted files', async () => {
    expect(await drafts.isEmpty(projectId, packId)).toBe(true);
  });

  it('is empty when every drafted file matches the workspace byte for byte', async () => {
    await seedWorkspace('src/a.ts', 'unchanged\n');
    await drafts.write(projectId, packId, 'src/a.ts', 'unchanged\n');
    expect(await drafts.isEmpty(projectId, packId)).toBe(true);
  });

  it('is not empty for a real change, a new file, or a deletion', async () => {
    await seedWorkspace('src/a.ts', 'before\n');
    await drafts.write(projectId, packId, 'src/a.ts', 'after\n');
    expect(await drafts.isEmpty(projectId, packId)).toBe(false);

    await drafts.discard(projectId, packId);
    await drafts.write(projectId, packId, 'src/new.ts', 'new\n');
    expect(await drafts.isEmpty(projectId, packId)).toBe(false);

    await drafts.discard(projectId, packId);
    await drafts.delete(projectId, packId, 'src/a.ts');
    expect(await drafts.isEmpty(projectId, packId)).toBe(false);
  });
});

describe('DiffpackDraftStore containment', () => {
  it('refuses to escape the pack folder', async () => {
    await expect(drafts.write(projectId, packId, '../../../etc/passwd', 'nope')).rejects.toThrow();
  });
});
