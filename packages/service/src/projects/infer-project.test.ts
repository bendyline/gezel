import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  INFERRED_PROJECT_ORIGIN_PROPERTY,
  INFERRED_PROJECT_SOURCE_PROPERTY,
  INFERRED_PROJECT_WELL_KNOWN_PROPERTY,
} from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import { HistoryManager } from '../history/manager.js';
import {
  type InferProjectDeps,
  InferProjectError,
  inferProjectForPath,
  listWellKnownFolders,
} from './infer-project.js';

let root: string;
let gezelHome: string;
let userHome: string;
let store: Store;
let history: HistoryManager;
let deps: InferProjectDeps;

async function touch(path: string): Promise<string> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, 'x');
  return path;
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'gezel-infer-')));
  gezelHome = join(root, 'gezel-home');
  userHome = join(root, 'home', 'me');
  await mkdir(join(userHome, 'Documents'), { recursive: true });
  await mkdir(join(userHome, 'Pictures'), { recursive: true });
  history = new HistoryManager(gezelHome);
  store = new Store({ home: gezelHome, history });
  await store.ensureLayout();
  await store.ensureDefaultProject();
  deps = {
    store,
    home: gezelHome,
    history,
    createProject: (body) => store.createProject(body),
    homedir: userHome,
    env: {},
    // The test tree lives under the real temp dir; point the temp rule elsewhere.
    tmpdir: join(root, 'not-the-temp-dir'),
    tempRoots: [],
  };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('inferProjectForPath', () => {
  it('creates a read-only project for the Documents folder and stamps provenance', async () => {
    const doc = await touch(join(userHome, 'Documents', 'budget.xlsx'));
    const res = await inferProjectForPath(deps, { path: doc, source: 'office' });
    expect(res.created).toBe(true);
    expect(res.matchedBy).toBe('well-known');
    expect(res.root).toBe(join(userHome, 'Documents'));
    expect(res.readOnly).toBe(true);
    expect(res.wellKnown).toEqual({ kind: 'documents', label: 'Documents' });
    expect(res.project?.name).toBe('Documents');
    expect(res.project?.workingDir).toBe(join(userHome, 'Documents'));
    expect(res.project?.managedWorkspaceWritePolicy).toBeUndefined();
    expect(res.project?.properties).toMatchObject({
      [INFERRED_PROJECT_ORIGIN_PROPERTY]: 'well-known',
      [INFERRED_PROJECT_SOURCE_PROPERTY]: 'office',
      [INFERRED_PROJECT_WELL_KNOWN_PROPERTY]: 'documents',
    });
    const events = await history.listEvents({ kinds: ['project.inferred'] });
    expect(events).toHaveLength(1);
  });

  it('reuses the project on the next open without logging again', async () => {
    const doc = await touch(join(userHome, 'Documents', 'budget.xlsx'));
    const first = await inferProjectForPath(deps, { path: doc });
    const second = await inferProjectForPath(deps, { path: doc });
    expect(second.created).toBe(false);
    expect(second.matchedBy).toBe('existing');
    expect(second.project?.id).toBe(first.project?.id);
    expect(await history.listEvents({ kinds: ['project.inferred'] })).toHaveLength(1);
  });

  it('finds the sibling-grouping folder inside Documents', async () => {
    const doc = await touch(join(userHome, 'Documents', 'engineeringdocs', 'alpha', 'report.docx'));
    await touch(join(userHome, 'Documents', 'engineeringdocs', 'bravo', 'spec.docx'));
    const res = await inferProjectForPath(deps, { path: doc });
    expect(res.matchedBy).toBe('climb');
    expect(res.project?.name).toBe('engineeringdocs');
    expect(res.root).toBe(join(userHome, 'Documents', 'engineeringdocs'));
  });

  it('creates only one project when two documents in a folder open together', async () => {
    const a = await touch(join(userHome, 'work', 'alpha', 'a.docx'));
    const b = await touch(join(userHome, 'work', 'alpha', 'b.docx'));
    const [ra, rb] = await Promise.all([
      inferProjectForPath(deps, { path: a }),
      inferProjectForPath(deps, { path: b }),
    ]);
    expect(ra.project?.id).toBe(rb.project?.id);
    expect([ra.created, rb.created].filter(Boolean)).toHaveLength(1);
    const projects = await store.listProjects();
    expect(projects.filter((p) => p.workingDir === join(userHome, 'work', 'alpha'))).toHaveLength(
      1,
    );
  });

  it.runIf(process.platform !== 'win32')(
    'resolves a symlinked folder to the real folder project',
    async () => {
      const real = await touch(join(userHome, 'work', 'alpha', 'a.docx'));
      await symlink(join(userHome, 'work', 'alpha'), join(userHome, 'alias'));
      const first = await inferProjectForPath(deps, { path: real });
      const viaLink = await inferProjectForPath(deps, { path: join(userHome, 'alias', 'a.docx') });
      expect(viaLink.project?.id).toBe(first.project?.id);
    },
  );

  it.runIf(process.platform !== 'win32')(
    'matches a project stored with a symlinked workingDir',
    async () => {
      await touch(join(userHome, 'work', 'alpha', 'a.docx'));
      await symlink(join(userHome, 'work', 'alpha'), join(userHome, 'alias'));
      const stored = await store.createProject({
        name: 'Aliased',
        workingDir: join(userHome, 'alias'),
      });
      const res = await inferProjectForPath(deps, {
        path: join(userHome, 'work', 'alpha', 'a.docx'),
      });
      expect(res.matchedBy).toBe('existing');
      expect(res.project?.id).toBe(stored.id);
    },
  );

  it('falls back to the Default project for a document in the home folder', async () => {
    const doc = await touch(join(userHome, 'loose.docx'));
    const res = await inferProjectForPath(deps, { path: doc });
    expect(res).toMatchObject({ matchedBy: 'default', reason: 'user-home', created: false });
    expect(res.project?.id).toBe('default');
  });

  it('answers the Default project for an unsaved document', async () => {
    const res = await inferProjectForPath(deps, {});
    expect(res).toMatchObject({ matchedBy: 'default', reason: 'no-path' });
    expect(res.project?.id).toBe('default');
  });

  it('previews without creating when create is false', async () => {
    const doc = await touch(join(userHome, 'work', 'alpha', 'a.docx'));
    const res = await inferProjectForPath(deps, { path: doc, create: false });
    expect(res).toMatchObject({
      project: null,
      created: false,
      matchedBy: 'parent',
      readOnly: true,
    });
    expect((await store.listProjects()).some((p) => p.name === 'alpha')).toBe(false);
  });

  it('rejects relative paths and missing folders', async () => {
    await expect(inferProjectForPath(deps, { path: 'relative/x.docx' })).rejects.toMatchObject({
      code: 'invalid_path',
      status: 400,
    });
    await expect(
      inferProjectForPath(deps, { path: join(userHome, 'nope', 'x.docx') }),
    ).rejects.toMatchObject({ code: 'path_not_found', status: 404 });
  });

  describe('folders', () => {
    it('refuses to make a project of the home folder', async () => {
      const err = await inferProjectForPath(deps, { path: userHome, kind: 'folder' }).catch(
        (e) => e,
      );
      expect(err).toBeInstanceOf(InferProjectError);
      expect(err).toMatchObject({ code: 'forbidden_root', status: 403, reason: 'user-home' });
    });

    it('adopts an unbound project of the same name (folder callers only)', async () => {
      await mkdir(join(userHome, 'code', 'widget'), { recursive: true });
      const orphan = await store.createProject({ name: 'widget' });
      const res = await inferProjectForPath(deps, {
        path: join(userHome, 'code', 'widget'),
        kind: 'folder',
        mode: 'crew',
      });
      expect(res.project?.id).toBe(orphan.id);
      expect(res.created).toBe(false);
      expect(res.project?.workingDir).toBe(join(userHome, 'code', 'widget'));
    });

    it('binds a folder the application has not created yet', async () => {
      const planned = join(userHome, 'apps', 'journal');
      const res = await inferProjectForPath(deps, { path: planned, kind: 'folder' });
      expect(res.created).toBe(true);
      expect(res.project?.workingDir).toBe(planned);
      const again = await inferProjectForPath(deps, { path: planned, kind: 'folder' });
      expect(again.project?.id).toBe(res.project?.id);
      expect(again.created).toBe(false);
    });

    it('refuses a file where a folder was asked for', async () => {
      const file = await touch(join(userHome, 'code', 'notes.txt'));
      await expect(inferProjectForPath(deps, { path: file, kind: 'folder' })).rejects.toMatchObject(
        { code: 'invalid_path', status: 400 },
      );
    });

    it("stores the caller's spelling of a symlinked folder and matches its target", async () => {
      const real = join(userHome, 'code', 'real-widget');
      await mkdir(real, { recursive: true });
      const link = join(userHome, 'code', 'widget-link');
      await symlink(real, link);
      const res = await inferProjectForPath(deps, { path: link, kind: 'folder' });
      expect(res.created).toBe(true);
      expect(res.project?.workingDir).toBe(link);
      const viaTarget = await inferProjectForPath(deps, { path: real, kind: 'folder' });
      expect(viaTarget.project?.id).toBe(res.project?.id);
      expect(viaTarget.created).toBe(false);
    });

    it('never adopts a same-named project for a document', async () => {
      const orphan = await store.createProject({ name: 'Documents' });
      const doc = await touch(join(userHome, 'Documents', 'x.docx'));
      const res = await inferProjectForPath(deps, { path: doc });
      expect(res.project?.id).not.toBe(orphan.id);
      expect(res.created).toBe(true);
    });
  });
});

describe('listWellKnownFolders', () => {
  it('reports the standard folders with counts and the project that owns them', async () => {
    await touch(join(userHome, 'Documents', 'a.docx'));
    await touch(join(userHome, 'Documents', 'b.pdf'));
    await mkdir(join(userHome, 'Documents', 'sub'));
    await inferProjectForPath(deps, { path: join(userHome, 'Documents', 'a.docx') });
    const { folders } = await listWellKnownFolders(deps);
    const docs = folders.find((f) => f.kind === 'documents');
    expect(docs).toMatchObject({ exists: true, itemCount: 3, documentCount: 2 });
    expect(docs?.projectId).toBeDefined();
    const music = folders.find((f) => f.kind === 'music');
    expect(music).toMatchObject({ exists: false });
    // Speculative cloud locations are omitted when absent.
    expect(folders.some((f) => f.kind === 'cloud')).toBe(false);
  });
});
