import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import { artifactReadRoots } from '../workspace/artifact-read-roots.js';
import { KeptLocalData, keptLocalSource } from './kept-local.js';

let home: string;
let store: Store;
let data: KeptLocalData;
let projectId: string;

const CALENDAR = { id: 'calendar-google:ab12', type: 'calendar-google', displayName: 'Work' };

async function bind(
  ...connectors: Array<{
    id: string;
    type: string;
    displayName?: string;
    corpusDir?: string;
    allowCloudModels?: boolean;
  }>
): Promise<void> {
  await store.updateProject(projectId, {
    connectors: connectors.map((c) => ({ config: {}, ...c })),
  });
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-kept-local-'));
  store = new Store({ home });
  await store.ensureLayout();
  projectId = (await store.createProject({ name: 'Week' })).id;
  data = new KeptLocalData(store);
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('what stays on this computer', () => {
  it('is a Google connection until the person allows cloud models', async () => {
    await bind({ ...CALENDAR, corpusDir: 'data/work' });
    expect((await data.areas(projectId)).map((a) => a.path)).toEqual(['data/work']);

    await bind({ ...CALENDAR, corpusDir: 'data/work', allowCloudModels: true });
    expect(await data.areas(projectId)).toEqual([]);
  });

  it('covers a binding whose folder was never recorded', async () => {
    await bind({ id: 'calendar-google:ab12', type: 'calendar-google' });
    expect((await data.areas(projectId)).map((a) => a.path)).toEqual(['data/calendar-google']);
  });

  it('leaves every other connection alone', async () => {
    await bind(
      { id: 'rss', type: 'rss-feed', corpusDir: 'data/news' },
      { id: 'ms', type: 'calendar-microsoft', corpusDir: 'data/outlook' },
    );
    expect(await data.areas(projectId)).toEqual([]);
  });

  it('finds a kept file however its path is spelled', async () => {
    await bind({ ...CALENDAR, corpusDir: 'data/work' });
    const areas = await data.areas(projectId);
    for (const path of [
      'data/work/2026/standup.md',
      'artifacts/data/work/x.md',
      'DATA/Work/x.md',
      'data/./work//x.md',
      'reports/../data/work/x.md',
      'data\\work\\x.md',
    ]) {
      expect(data.areaForPath(areas, path)?.source.name, path).toBe('Work');
    }
    for (const path of ['data/workshop/x.md', 'data', 'reports/work.md']) {
      expect(data.areaForPath(areas, path), path).toBeUndefined();
    }
  });

  it('finds a kept file behind a link', async () => {
    await bind({ ...CALENDAR, corpusDir: 'data/work' });
    const artifacts = store.projectArtifactsDir(projectId);
    await mkdir(join(artifacts, 'data/work'), { recursive: true });
    await writeFile(join(artifacts, 'data/work/standup.md'), 'standup');
    await symlink(join(artifacts, 'data/work'), join(artifacts, 'shortcut'));
    const areas = await data.areas(projectId);
    const file = join(artifacts, 'shortcut/standup.md');
    expect((await data.areaForFile(projectId, areas, file))?.source.name).toBe('Work');
  });
});

describe('an input that names a folder', () => {
  it('touches what it is in and what is in it', async () => {
    await bind({ ...CALENDAR, corpusDir: 'data/work' });
    const areas = await data.areas(projectId);
    for (const path of ['data', 'data/work', 'data/work/2026', 'artifacts/data/']) {
      expect(data.areasTouching(areas, path), path).toHaveLength(1);
    }
    for (const path of ['reports', 'data/news', 'data/workshop']) {
      expect(data.areasTouching(areas, path), path).toEqual([]);
    }
  });
});

describe('the ledger', () => {
  const source = () => keptLocalSource(projectId, CALENDAR);

  it('keeps what a conversation wrote, until the person allows cloud models', async () => {
    await bind({ ...CALENDAR, corpusDir: 'data/work' });
    await data.remember(projectId, ['reports/week.md', 'tasks/4'], [source()]);
    await data.remember(projectId, ['tasks/4/outline.md', 'reports/week.md'], [source()]);
    expect((await data.areas(projectId)).map((a) => a.path)).toEqual([
      'data/work',
      'reports/week.md',
      'tasks/4',
    ]);

    await bind({ ...CALENDAR, corpusDir: 'data/work', allowCloudModels: true });
    expect(await data.areas(projectId)).toEqual([]);
  });

  it('keeps what a removed connection left, until a new one takes its folder', async () => {
    await store.updateKeptLocal(projectId, () => [{ path: 'data/work', source: source() }]);
    expect((await data.areas(projectId)).map((a) => a.path)).toEqual(['data/work']);

    await bind({ ...CALENDAR, id: 'calendar-google:new', corpusDir: 'data/work' });
    expect((await data.areas(projectId)).map((a) => a.source.bindingId)).toEqual([
      'calendar-google:new',
    ]);
    await bind({
      ...CALENDAR,
      id: 'calendar-google:new',
      corpusDir: 'data/work',
      allowCloudModels: true,
    });
    expect(await data.areas(projectId)).toEqual([]);
  });

  it('ignores an unreadable file and an unreadable entry', async () => {
    const file = join(home, 'projects', projectId, 'kept-local.json');
    await mkdir(join(home, 'projects', projectId), { recursive: true });
    await writeFile(file, '{ not json');
    expect(await store.readKeptLocal(projectId)).toEqual([]);
    await writeFile(
      file,
      JSON.stringify({ version: 1, entries: [{ path: 1 }, { path: 'a.md', source: source() }] }),
    );
    expect((await store.readKeptLocal(projectId)).map((e) => e.path)).toEqual(['a.md']);
  });

  it('never narrows when it folds an overgrown list', async () => {
    const paths = Array.from({ length: 2100 }, (_, i) => `reports/day-${i}.md`);
    await data.remember(projectId, paths, [source()]);
    const areas = await data.areas(projectId);
    expect(areas.length).toBeLessThan(2100);
    for (const path of [paths[0]!, paths[1500]!, paths[2099]!]) {
      expect(data.areaForPath(areas, path), path).toBeDefined();
    }
  });
});

describe('where a kept source reaches', () => {
  it('finds the connections a memory names, and holds for one that is gone', async () => {
    await bind({ ...CALENDAR, corpusDir: 'data/work' });
    expect(await data.sourcesForTags(['calendar-google.ab12'])).toEqual([
      { projectId, bindingId: CALENDAR.id, name: 'Work' },
    ]);
    const gone = await data.sourcesForTags(['mail-gmail.zz99']);
    expect(gone).toHaveLength(1);
    expect(await data.active(gone)).toHaveLength(1);
  });

  it('names every kept folder in the home for an agent that reads absolute paths', async () => {
    expect(await data.everywhere()).toEqual([]);
    await bind({ ...CALENDAR, corpusDir: 'data/work' });
    expect(await data.everywhere()).toEqual([
      join(store.projectArtifactsDir(projectId), 'data/work'),
      store.projectQuarantineDir(projectId),
    ]);
  });
});

describe('artifactReadRoots', () => {
  it('grants everything beside what is kept', async () => {
    const root = store.projectArtifactsDir(projectId);
    for (const dir of ['data/work', 'data/news', 'reports', 'tasks/4']) {
      await mkdir(join(root, dir), { recursive: true });
    }
    await writeFile(join(root, 'notes.md'), 'x');
    await writeFile(join(root, 'reports/week.md'), 'x');
    await writeFile(join(root, 'reports/month.md'), 'x');
    await symlink(join(root, 'data/work'), join(root, 'shortcut'));

    expect(await artifactReadRoots(root, [])).toEqual([root]);
    const roots = await artifactReadRoots(root, ['data/work', 'reports/week.md']);
    // Grants are host paths, so Windows answers with backslashes.
    expect(roots.map((r) => r.slice(root.length + 1).replaceAll('\\', '/')).sort()).toEqual([
      'data/news',
      'notes.md',
      'reports/month.md',
      'tasks',
    ]);
  });
});
