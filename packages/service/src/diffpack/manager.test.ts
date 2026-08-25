import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '@bendyline/gezel';
import { DiffpackManifestSchema } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import type { TaskManager } from '../tasks/manager.js';
import { DiffpackDriftedError, DiffpackManager, overlapsFor, slugify } from './manager.js';

let home: string;
let store: Store;
let manager: DiffpackManager;
let projectId: string;
const tasks = new Map<string, Task>();

const fakeTasks = {
  getByRef: async (ref: string) => tasks.get(ref) ?? null,
} as unknown as TaskManager;

async function seedWorkspace(rel: string, content: string): Promise<void> {
  const wd = await store.projectWorkspaceDir(projectId);
  const full = join(wd, rel);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, content, 'utf8');
}

async function readWorkspace(rel: string): Promise<string | null> {
  return store.readProjectWorkspaceFile(projectId, rel);
}

/** Create a pack, draft the given edits into it, and seal. */
async function draftAndSeal(
  packId: string,
  edits: (drafts: DiffpackManager['drafts']) => Promise<void>,
  title = 'Fix the thing',
) {
  await manager.ensure(projectId, packId, {
    title,
    origin: { kind: 'boekwachter-issue', issueRefs: ['BW-1'] },
    taskRef: `${projectId}/${packId}`,
    gezelName: 'Rex',
  });
  await edits(manager.drafts);
  return manager.seal(projectId, packId);
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-diffpack-mgr-test-'));
  store = new Store({ home });
  await store.ensureLayout();
  const project = await store.createProject({ name: 'Fixture' });
  projectId = project.id;
  await mkdir(await store.projectWorkspaceDir(projectId), { recursive: true });
  tasks.clear();
  manager = new DiffpackManager({ home, store, tasks: fakeTasks });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('DiffpackManager.ensure', () => {
  it('registers a drafting pack and is idempotent on packId', async () => {
    const first = await manager.ensure(projectId, '1', {
      title: 'Fix BW-3',
      origin: { kind: 'boekwachter-issue', issueRefs: ['BW-3'] },
      taskRef: `${projectId}/1`,
    });
    expect(first.status).toBe('drafting');
    expect(first.notesPath).toBe('diffpacks/1/notes.md');

    const again = await manager.ensure(projectId, '1', {
      title: 'Different title',
      origin: { kind: 'manual' },
      taskRef: `${projectId}/999`,
    });
    expect(again.title).toBe('Fix BW-3');
    expect(await manager.list(projectId)).toHaveLength(1);
  });
});

describe('DiffpackManager.seal', () => {
  it('produces a diff that applies back cleanly', async () => {
    await seedWorkspace('src/a.ts', 'const a = 1;\nconst b = 2;\n');
    const sealed = await draftAndSeal('1', async (drafts) => {
      await drafts.replaceIn(projectId, '1', {
        path: 'src/a.ts',
        find: 'a = 1',
        replace: 'a = 42',
      });
    });

    expect(sealed.status).toBe('ready');
    expect(sealed.files).toHaveLength(1);
    expect(sealed.files[0]).toMatchObject({ path: 'src/a.ts', change: 'modify', additions: 1 });
    // Untouched until the user applies.
    expect(await readWorkspace('src/a.ts')).toBe('const a = 1;\nconst b = 2;\n');

    const result = await manager.apply(projectId, '1');
    expect(result.ok).toBe(true);
    expect(await readWorkspace('src/a.ts')).toBe('const a = 42;\nconst b = 2;\n');
  });

  it('drops files the gezel opened but did not change', async () => {
    await seedWorkspace('src/a.ts', 'unchanged\n');
    await seedWorkspace('src/b.ts', 'before\n');
    const sealed = await draftAndSeal('1', async (drafts) => {
      await drafts.write(projectId, '1', 'src/a.ts', 'unchanged\n');
      await drafts.write(projectId, '1', 'src/b.ts', 'after\n');
    });
    expect(sealed.files.map((f) => f.path)).toEqual(['src/b.ts']);
  });

  it('marks a pack that proposed nothing as failed rather than ready', async () => {
    await seedWorkspace('src/a.ts', 'same\n');
    const sealed = await draftAndSeal('1', async (drafts) => {
      await drafts.write(projectId, '1', 'src/a.ts', 'same\n');
    });
    expect(sealed.status).toBe('failed');
    expect(sealed.error).toMatch(/without proposing any change/i);
  });

  it('records new files and deletions with the right change kind', async () => {
    await seedWorkspace('src/dead.ts', 'unused\n');
    const sealed = await draftAndSeal('1', async (drafts) => {
      await drafts.write(projectId, '1', 'src/new.ts', 'hello\n');
      await drafts.delete(projectId, '1', 'src/dead.ts');
    });
    const byPath = Object.fromEntries(sealed.files.map((f) => [f.path, f]));
    expect(byPath['src/new.ts']?.change).toBe('add');
    expect(byPath['src/new.ts']?.baseHash).toBe('');
    expect(byPath['src/dead.ts']?.change).toBe('delete');
    expect(byPath['src/dead.ts']?.diffArtifact).toBe('');
  });

  it('writes a self-contained manifest beside the diffs', async () => {
    await seedWorkspace('src/a.ts', 'before\n');
    await seedWorkspace('src/gone.ts', 'x\n');
    await draftAndSeal('1', async (drafts) => {
      await drafts.write(projectId, '1', 'src/a.ts', 'after\n');
      await drafts.delete(projectId, '1', 'src/gone.ts');
    });
    const raw = await store.readProjectArtifact(projectId, 'diffpacks/1/manifest.json');
    const manifest = DiffpackManifestSchema.parse(JSON.parse(raw ?? ''));
    expect(manifest.packId).toBe('1');
    expect(manifest.deletions).toEqual(['src/gone.ts']);
    expect(manifest.gezelName).toBe('Rex');
  });

  it('takes its summary from the first prose line of the notes', async () => {
    await seedWorkspace('src/a.ts', 'before\n');
    await manager.ensure(projectId, '1', {
      title: 'T',
      origin: { kind: 'manual' },
      taskRef: `${projectId}/1`,
    });
    await store.writeProjectArtifact(
      projectId,
      'diffpacks/1/notes.md',
      '# Fix\n\nThe parser dropped the trailing comma.\n',
    );
    await manager.drafts.write(projectId, '1', 'src/a.ts', 'after\n');
    const sealed = await manager.seal(projectId, '1');
    expect(sealed.summary).toBe('The parser dropped the trailing comma.');
  });

  it('falls back to the task folder fix-notes.md when the pack has no notes', async () => {
    await seedWorkspace('src/a.ts', 'before\n');
    const taskRef = `${projectId}/7`;
    tasks.set(taskRef, {
      ref: taskRef,
      num: 7,
      artifactDir: 'tasks/7',
    } as unknown as Task);
    await manager.ensure(projectId, '7', {
      title: 'T',
      origin: { kind: 'manual' },
      taskRef,
    });
    // A mode-agnostic book explains its change at <task.dir>/fix-notes.md —
    // it never writes diffpacks/<id>/notes.md, because that path only exists
    // in drafting mode.
    await store.writeProjectArtifact(
      projectId,
      'tasks/7/fix-notes.md',
      '## Problem\n\nThe validator rejected empty arrays.\n',
    );
    await manager.drafts.write(projectId, '7', 'src/a.ts', 'after\n');
    const sealed = await manager.seal(projectId, '7');
    expect(sealed.summary).toBe('The validator rejected empty arrays.');
  });
});

describe('DiffpackManager drift', () => {
  it('flags a file that changed after the pack was sealed', async () => {
    await seedWorkspace('src/a.ts', 'const a = 1;\n');
    await draftAndSeal('1', async (drafts) => {
      await drafts.replaceIn(projectId, '1', { path: 'src/a.ts', find: '1', replace: '2' });
    });
    expect((await manager.get(projectId, '1')).drifted).toEqual([]);

    await seedWorkspace('src/a.ts', 'const a = 1; // touched by hand\n');
    expect((await manager.get(projectId, '1')).drifted).toEqual(['src/a.ts']);
  });

  it('refuses to apply a drifted pack, and names the paths', async () => {
    await seedWorkspace('src/a.ts', 'const a = 1;\n');
    await draftAndSeal('1', async (drafts) => {
      await drafts.replaceIn(projectId, '1', { path: 'src/a.ts', find: '1', replace: '2' });
    });
    await seedWorkspace('src/a.ts', 'totally different\n');

    await expect(manager.apply(projectId, '1')).rejects.toBeInstanceOf(DiffpackDriftedError);
    await expect(manager.apply(projectId, '1')).rejects.toMatchObject({ paths: ['src/a.ts'] });
  });

  it('treats an `add` whose path now exists as drift', async () => {
    const sealed = await draftAndSeal('1', async (drafts) => {
      await drafts.write(projectId, '1', 'src/new.ts', 'mine\n');
    });
    expect(sealed.files[0]?.change).toBe('add');
    expect((await manager.get(projectId, '1')).drifted).toEqual([]);

    await seedWorkspace('src/new.ts', 'someone else got there first\n');
    expect((await manager.get(projectId, '1')).drifted).toEqual(['src/new.ts']);
  });

  it('stops reporting drift once the pack is terminal', async () => {
    await seedWorkspace('src/a.ts', 'const a = 1;\n');
    await draftAndSeal('1', async (drafts) => {
      await drafts.replaceIn(projectId, '1', { path: 'src/a.ts', find: '1', replace: '2' });
    });
    await manager.dismiss(projectId, '1');
    await seedWorkspace('src/a.ts', 'changed\n');
    expect((await manager.get(projectId, '1')).drifted).toEqual([]);
  });
});

describe('DiffpackManager overlap', () => {
  it('reports two live packs that touch the same file, in both directions', async () => {
    await seedWorkspace('src/a.ts', 'value = 0\n');
    await seedWorkspace('src/b.ts', 'other\n');
    await draftAndSeal('1', async (drafts) => {
      await drafts.replaceIn(projectId, '1', { path: 'src/a.ts', find: '0', replace: '1' });
    });
    await draftAndSeal('2', async (drafts) => {
      await drafts.replaceIn(projectId, '2', { path: 'src/a.ts', find: '0', replace: '2' });
      await drafts.replaceIn(projectId, '2', { path: 'src/b.ts', find: 'other', replace: 'new' });
    });

    expect((await manager.get(projectId, '1')).overlaps).toEqual([
      { path: 'src/a.ts', packIds: ['2'] },
    ]);
    expect((await manager.get(projectId, '2')).overlaps).toEqual([
      { path: 'src/a.ts', packIds: ['1'] },
    ]);
  });

  it('drops the overlap once one side is applied, and drifts the other', async () => {
    await seedWorkspace('src/a.ts', 'value = 0\n');
    await draftAndSeal('1', async (drafts) => {
      await drafts.replaceIn(projectId, '1', { path: 'src/a.ts', find: '0', replace: '1' });
    });
    await draftAndSeal('2', async (drafts) => {
      await drafts.replaceIn(projectId, '2', { path: 'src/a.ts', find: '0', replace: '2' });
    });

    await manager.apply(projectId, '1');

    const survivor = await manager.get(projectId, '2');
    expect(survivor.overlaps).toEqual([]);
    expect(survivor.drifted).toEqual(['src/a.ts']);
  });

  it('ignores packs that are no longer live', () => {
    const base = {
      projectId: 'p',
      title: 't',
      summary: '',
      origin: { kind: 'manual' as const },
      taskRef: 'p/1',
      notesPath: 'n',
      manifestPath: 'm',
      createdAt: 'now',
      files: [
        {
          path: 'a.ts',
          diffArtifact: 'd',
          baseHash: 'h',
          additions: 1,
          deletions: 0,
          change: 'modify' as const,
        },
      ],
    };
    const live = { ...base, packId: '1', status: 'ready' as const };
    const gone = { ...base, packId: '2', status: 'dismissed' as const };
    expect(overlapsFor(live, [live, gone])).toEqual([]);
  });
});

describe('DiffpackManager.apply', () => {
  it('applies a subset and reports the pack as partially applied', async () => {
    await seedWorkspace('src/a.ts', 'a0\n');
    await seedWorkspace('src/b.ts', 'b0\n');
    await draftAndSeal('1', async (drafts) => {
      await drafts.write(projectId, '1', 'src/a.ts', 'a1\n');
      await drafts.write(projectId, '1', 'src/b.ts', 'b1\n');
    });

    const result = await manager.apply(projectId, '1', { paths: ['src/a.ts'] });
    expect(result.ok).toBe(true);
    expect(await readWorkspace('src/a.ts')).toBe('a1\n');
    expect(await readWorkspace('src/b.ts')).toBe('b0\n');
    expect((await manager.get(projectId, '1')).status).toBe('partially-applied');
  });

  it('removes tombstoned files', async () => {
    await seedWorkspace('src/dead.ts', 'unused\n');
    await draftAndSeal('1', async (drafts) => {
      await drafts.delete(projectId, '1', 'src/dead.ts');
    });
    const result = await manager.apply(projectId, '1');
    expect(result.ok).toBe(true);
    expect(await readWorkspace('src/dead.ts')).toBeNull();
  });

  it('applies over a drifted target only when explicitly allowed', async () => {
    await seedWorkspace('src/a.ts', 'one\ntwo\nthree\nfour\nfive\n');
    await draftAndSeal('1', async (drafts) => {
      await drafts.replaceIn(projectId, '1', { path: 'src/a.ts', find: 'one', replace: 'ONE' });
    });
    // Drift far from the hunk: the hash changes but the patch still applies.
    await seedWorkspace('src/a.ts', 'one\ntwo\nthree\nfour\nfive\nsix\n');

    await expect(manager.apply(projectId, '1')).rejects.toBeInstanceOf(DiffpackDriftedError);
    const forced = await manager.apply(projectId, '1', { allowDrifted: true });
    expect(forced.ok).toBe(true);
    expect(await readWorkspace('src/a.ts')).toBe('ONE\ntwo\nthree\nfour\nfive\nsix\n');
  });

  it('does not force a rejected hunk through even when drift is allowed', async () => {
    await seedWorkspace('src/a.ts', 'alpha\nbravo\ncharlie\n');
    await draftAndSeal('1', async (drafts) => {
      await drafts.replaceIn(projectId, '1', { path: 'src/a.ts', find: 'bravo', replace: 'BRAVO' });
    });
    await seedWorkspace('src/a.ts', 'completely\nunrelated\ncontent\nnow\n');

    const result = await manager.apply(projectId, '1', { allowDrifted: true });
    expect(result.ok).toBe(false);
    expect(result.results[0]?.error).toMatch(/did not apply cleanly/i);
    expect(await readWorkspace('src/a.ts')).toBe('completely\nunrelated\ncontent\nnow\n');
    expect((await manager.get(projectId, '1')).status).toBe('failed');
  });

  it('fails the whole pack when a diff sidecar has gone missing', async () => {
    await seedWorkspace('src/a.ts', 'a0\n');
    await seedWorkspace('src/b.ts', 'b0\n');
    const sealed = await draftAndSeal('1', async (drafts) => {
      await drafts.write(projectId, '1', 'src/a.ts', 'a1\n');
      await drafts.write(projectId, '1', 'src/b.ts', 'b1\n');
    });
    await store.deleteProjectArtifact(projectId, sealed.files[0]!.diffArtifact);

    const result = await manager.apply(projectId, '1');
    expect(result.ok).toBe(false);
    expect(await readWorkspace('src/b.ts')).toBe('b0\n');
  });
});

describe('DiffpackManager applies to a workspace gezels cannot write', () => {
  it('succeeds as a user-initiated write while a gezel write still fails', async () => {
    const external = join(home, 'external');
    await mkdir(external, { recursive: true });
    await writeFile(join(external, 'a.ts'), 'const a = 1;\n', 'utf8');
    const ext = await store.createProject({ name: 'External', workingDir: external });

    await manager.ensure(ext.id, '1', {
      title: 'Fix',
      origin: { kind: 'manual' },
      taskRef: `${ext.id}/1`,
    });
    await manager.drafts.replaceIn(ext.id, '1', {
      path: 'a.ts',
      find: 'a = 1',
      replace: 'a = 2',
    });
    await manager.seal(ext.id, '1');

    // The gezel path is still shut.
    await expect(
      store.writeProjectWorkspaceFile(ext.id, 'a.ts', 'sneaky', { gezelId: 'rex' }),
    ).rejects.toThrow();

    const result = await manager.apply(ext.id, '1');
    expect(result.ok).toBe(true);
    expect(await readFile(join(external, 'a.ts'), 'utf8')).toBe('const a = 2;\n');
  });
});

describe('DiffpackManager.settleForTask', () => {
  it('seals on completion', async () => {
    await seedWorkspace('src/a.ts', 'before\n');
    await manager.ensure(projectId, '4', {
      title: 'T',
      origin: { kind: 'manual' },
      taskRef: `${projectId}/4`,
    });
    await manager.drafts.write(projectId, '4', 'src/a.ts', 'after\n');

    expect(await manager.settleForTask(projectId, `${projectId}/4`, 'complete')).toBe(1);
    expect((await manager.get(projectId, '4')).status).toBe('ready');
  });

  it('discards the draft on cancel rather than half-sealing it', async () => {
    await seedWorkspace('src/a.ts', 'before\n');
    await manager.ensure(projectId, '4', {
      title: 'T',
      origin: { kind: 'manual' },
      taskRef: `${projectId}/4`,
    });
    await manager.drafts.write(projectId, '4', 'src/a.ts', 'after\n');

    await manager.settleForTask(projectId, `${projectId}/4`, 'canceled');
    const pack = await manager.get(projectId, '4');
    expect(pack.status).toBe('failed');
    expect(pack.files).toEqual([]);
    expect(await manager.drafts.listDraftedPaths(projectId, '4')).toEqual([]);
  });

  it('ignores packs whose task already settled', async () => {
    await manager.ensure(projectId, '4', {
      title: 'T',
      origin: { kind: 'manual' },
      taskRef: `${projectId}/4`,
    });
    await manager.settleForTask(projectId, `${projectId}/4`, 'complete');
    expect(await manager.settleForTask(projectId, `${projectId}/4`, 'complete')).toBe(0);
  });
});

describe('the machine-owned halves of a pack are not tool-writable', () => {
  it('refuses write_artifact into after/ and files/ but allows notes.md', async () => {
    await expect(
      store.writeProjectArtifact(projectId, 'diffpacks/1/after/src/a.ts', 'forged'),
    ).rejects.toThrow(/written by the runtime/i);
    await expect(
      store.writeProjectArtifact(projectId, 'diffpacks/1/files/01-a.ts.diff', 'forged'),
    ).rejects.toThrow(/written by the runtime/i);
    await expect(
      store.writeProjectArtifact(projectId, 'diffpacks/1/notes.md', '# Fix\n'),
    ).resolves.toBeUndefined();
  });

  it('is not fooled by traversal or separator tricks', async () => {
    await expect(
      store.writeProjectArtifact(projectId, './diffpacks/1/after/../after/a.ts', 'forged'),
    ).rejects.toThrow(/written by the runtime/i);
  });
});

describe('slugify', () => {
  it('keeps the basename readable and filesystem-safe', () => {
    expect(slugify('src/deep/parser.ts')).toBe('parser.ts');
    expect(slugify('a b/we!rd@name.tsx')).toBe('we-rd-name.tsx');
    expect(slugify('')).toBe('file');
  });
});
