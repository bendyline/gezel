import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { indexWorkspaceContent } from '../index-store/content-indexer.js';
import { IndexStore } from '../index-store/index-store.js';
import { buildFileMap } from './build.js';
import { VillageFileStore } from './village-file.js';

// A two-package workspace: the app imports the core package by name, which
// only the resolved graph (policy 2) can see; the relative import inside the
// app is on both graphs.
let dir: string;
let store: IndexStore;

async function put(rel: string, body: string): Promise<void> {
  await mkdir(dirname(join(dir, rel)), { recursive: true });
  await writeFile(join(dir, rel), body);
}

function villageFile(): VillageFileStore {
  return new VillageFileStore({
    workspaceDir: dir,
    primaryPath: join(dir, '.gezel', 'village.json'),
    fallbackPath: join(dir, 'fallback-home', 'village.json'),
  });
}

const roadKeys = (roads: Array<{ a: string; b: string }>) =>
  roads.map((r) => `${r.a} -> ${r.b}`).sort();

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gezel-edge-policy-'));
  await put(
    'packages/core/package.json',
    JSON.stringify({ name: '@acme/core', main: 'dist/index.js' }),
  );
  await put('packages/core/src/index.ts', 'export function core() { return 1; }\n');
  await put(
    'packages/app/src/main.ts',
    "import { core } from '@acme/core';\nimport { helper } from './helper';\nexport const run = () => core() + helper();\n",
  );
  await put('packages/app/src/helper.ts', 'export function helper() { return 2; }\n');
  const opened = await IndexStore.open(join(dir, 'home', 'index.db'), {
    collectionId: 'p',
    kind: 'workspace',
    rootPath: dir,
  });
  if (!opened) throw new Error('index unavailable');
  store = opened;
  await indexWorkspaceContent(store, dir, join(dir, 'home', 'artifacts'));
});

afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

const CROSS = 'packages/app/src/main.ts -> packages/core/src/index.ts';
const LOCAL = 'packages/app/src/main.ts -> packages/app/src/helper.ts';

describe('the Village edge policy', () => {
  it('founds a new village on the resolved graph and records it', async () => {
    const city = villageFile();
    const map = await buildFileMap(store, dir, {
      persist: true,
      villageFile: city,
      userFacing: true,
    });
    expect(roadKeys(map.roads)).toEqual([LOCAL, CROSS]);
    expect(map.edgePolicy).toEqual({ current: 2 });
    expect((await city.read())?.domains.code?.edgePolicy).toBe(2);
  });

  it('keeps an existing village on the graph it was founded on, and offers the update', async () => {
    // A village from a build before the policy existed: a domain with no edgePolicy.
    await put(
      '.gezel/village.json',
      JSON.stringify({ schemaVersion: 1, domains: { code: { layoutVersion: 6 } } }),
    );
    const city = villageFile();
    const before = await buildFileMap(store, dir, {
      persist: true,
      villageFile: city,
      userFacing: true,
    });
    expect(roadKeys(before.roads)).toEqual([LOCAL]);
    expect(before.edgePolicy).toEqual({ current: 1, upgrade: { roadsNow: 1, roadsAfter: 2 } });
    const fileBefore = await readFile(join(dir, '.gezel', 'village.json'), 'utf8');
    expect(fileBefore).not.toContain('edgePolicy');

    // A rebuild that changes nothing still writes nothing new.
    await buildFileMap(store, dir, { persist: true, villageFile: city, userFacing: true });
    expect(await readFile(join(dir, '.gezel', 'village.json'), 'utf8')).toBe(fileBefore);

    const after = await buildFileMap(store, dir, {
      persist: true,
      villageFile: city,
      userFacing: true,
      edgePolicy: 2,
    });
    expect(roadKeys(after.roads)).toEqual([LOCAL, CROSS]);
    expect(after.edgePolicy).toEqual({ current: 2 });
    // Every building stays where it stood: the journal and anchors are the
    // same. Downtown may shift, because the richer graph changes which files
    // the town centers on; that is what the person asked for.
    const parsedBefore = JSON.parse(fileBefore);
    const parsedAfter = JSON.parse(await readFile(join(dir, '.gezel', 'village.json'), 'utf8'));
    expect(parsedAfter.domains.code.edgePolicy).toBe(2);
    expect(parsedAfter.domains.code.journal).toEqual(parsedBefore.domains.code.journal);
    expect(parsedAfter.domains.code.anchors).toEqual(parsedBefore.domains.code.anchors);

    // And it sticks without being asked again.
    const later = await buildFileMap(store, dir, {
      persist: true,
      villageFile: city,
      userFacing: true,
    });
    expect(later.edgePolicy).toEqual({ current: 2 });
  });

  it('remembers the policy in the index when there is no village file', async () => {
    const first = await buildFileMap(store, dir, { persist: true });
    expect(first.edgePolicy?.current).toBe(2);
    const second = await buildFileMap(store, dir, { persist: true });
    expect(second.edgePolicy?.current).toBe(2);
    expect(roadKeys(second.roads)).toEqual([LOCAL, CROSS]);
  });
});
