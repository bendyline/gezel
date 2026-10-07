import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CREW_RECRUITED_AT_PROPERTY,
  FOLDER_KIND_PROPERTY,
  INFERRED_PROJECT_WELL_KNOWN_PROPERTY,
  SHARED_PROJECT_MARKER,
} from '@bendyline/gezel';
import { CatalogService } from '@bendyline/gezel-catalog';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatManager } from '../chat/manager.js';
import { Store } from '../fs/store.js';
import { resolveProjectBoekwachter, resolveProjectDeveloper } from '../gezels/autonomous-roles.js';
import { recruitCrewForFolder } from './recruit-crew.js';

let home: string;
let store: Store;
let catalog: CatalogService;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-recruit-'));
  store = new Store({ home });
  await store.ensureLayout();
  await store.ensureDefaultProject();
  catalog = new CatalogService(undefined, { localRoot: home });
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const deps = () => ({ store, catalog, home, chat: {} as ChatManager });

async function folder(
  name: string,
  files: Record<string, string>,
  properties: Record<string, string> = {},
): Promise<string> {
  const dir = join(home, 'folders', name);
  for (const [path, body] of Object.entries(files)) {
    await mkdir(join(dir, path, '..'), { recursive: true });
    await writeFile(join(dir, path), body);
  }
  await mkdir(dir, { recursive: true });
  const project = await store.createProject({ name, mode: 'solo', workingDir: dir });
  if (Object.keys(properties).length > 0) await store.updateProject(project.id, { properties });
  return project.id;
}

const photos = Object.fromEntries(
  Array.from({ length: 8 }, (_, i) => [`2026/IMG_${i}.jpg`, 'jpeg']),
);
const sources = {
  'package.json': '{}',
  'src/a.ts': 'export {}',
  'src/b.ts': 'export {}',
  'src/c.ts': 'export {}',
  'README.md': '# x',
};

describe('recruitCrewForFolder', () => {
  it('leads a Pictures folder with the Boekwachter and seats no developer', async () => {
    const id = await folder('Pictures', photos, {
      [INFERRED_PROJECT_WELL_KNOWN_PROPERTY]: 'pictures',
    });

    const result = await recruitCrewForFolder(deps(), id);

    expect(result.kind).toBe('pictures');
    const project = await store.getProject(id);
    const boekwachter = await resolveProjectBoekwachter(store, id);
    expect(boekwachter).not.toBeNull();
    expect(project?.voormanGezelId).toBe(boekwachter?.id);
    expect(await resolveProjectDeveloper(store, id)).toBeNull();
    expect(project?.properties?.[FOLDER_KIND_PROPERTY]).toBe('pictures');
    expect(result.createdGezels.map((g) => g.id)).toEqual([boekwachter?.id]);
  });

  it('reads the file mix when the folder is not a well-known one', async () => {
    const id = await folder('Holiday', photos);
    expect((await recruitCrewForFolder(deps(), id)).kind).toBe('pictures');
  });

  it('gives a code folder the Builder as well, which unlocks proposed fixes', async () => {
    const id = await folder('app', sources);

    const result = await recruitCrewForFolder(deps(), id);

    expect(result.kind).toBe('code');
    expect(await resolveProjectBoekwachter(store, id)).not.toBeNull();
    const developer = await resolveProjectDeveloper(store, id);
    expect(developer?.templateId).toBe('builder');
    expect((await store.getProject(id))?.voormanGezelId).toBe(developer?.id);
  });

  it('runs once, so a gezel the person removed is not added back', async () => {
    const id = await folder('Pictures', photos, {
      [INFERRED_PROJECT_WELL_KNOWN_PROPERTY]: 'pictures',
    });
    await recruitCrewForFolder(deps(), id);
    const boekwachter = await resolveProjectBoekwachter(store, id);
    await store.updateProject(id, { voormanGezelId: null });
    await store.removeGezelFromProject(id, boekwachter!.id);

    const again = await recruitCrewForFolder(deps(), id);

    expect(again.skipped).toBe('already-recruited');
    expect((await store.getProject(id))?.gezelIds ?? []).toEqual([]);
  });

  it('keeps a lead the person chose', async () => {
    const id = await folder('Notes', { 'a.md': '# a', 'b.md': '# b' });
    const chosen = await store.createGezel({ name: 'Ada', role: 'Editor' });
    await store.updateProject(id, { voormanGezelId: chosen.id });

    await recruitCrewForFolder(deps(), id);

    expect((await store.getProject(id))?.voormanGezelId).toBe(chosen.id);
  });

  it('leaves the shared library and projects without a folder alone', async () => {
    const library = await store.createProject({ name: 'Library', workingDir: join(home, 'lib') });
    await store.updateProject(library.id, { properties: { [SHARED_PROJECT_MARKER]: '1' } });
    const plain = await store.createProject({ name: 'Plain' });

    expect((await recruitCrewForFolder(deps(), library.id)).skipped).toBe('library');
    expect((await recruitCrewForFolder(deps(), plain.id)).skipped).toBe('not-a-folder');
    expect((await store.getProject(plain.id))?.properties?.[CREW_RECRUITED_AT_PROPERTY]).toBe(
      undefined,
    );
  });
});
