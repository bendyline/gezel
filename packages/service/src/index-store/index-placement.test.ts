import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SHARED_PROJECT_MARKER } from '@bendyline/gezel';
import { projectContentIndexDbFile, projectLocalIndexDbFile } from '@bendyline/gezel/paths';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateWorkspaceIndexes } from './index-placement.js';

interface Db {
  exec(sql: string): void;
  prepare(sql: string): { get(): unknown };
  close(): void;
}
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => Db;
};

let home: string;
let ws: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-placement-home-'));
  ws = await mkdtemp(join(tmpdir(), 'gezel-placement-ws-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(ws, { recursive: true, force: true });
});

function storeWith(projects: Array<{ id: string; properties?: Record<string, string> }>) {
  return {
    listProjects: async () => projects.map((p) => ({ ...p, workingDir: ws })),
    projectWorkspaceDir: async () => ws,
  };
}

/** A legacy index as earlier builds left it: WAL mode, with uncheckpointed rows. */
async function seedLegacyIndex(rows = 3): Promise<string> {
  const legacy = projectLocalIndexDbFile(ws);
  await mkdir(join(ws, '.gezel', 'index'), { recursive: true });
  await writeFile(join(ws, '.gezel', 'index', '.gitignore'), '*\n');
  const db = new DatabaseSync(legacy);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
  db.exec('CREATE TABLE summaries (path TEXT, text TEXT);');
  for (let i = 0; i < rows; i++) {
    db.exec(`INSERT INTO summaries VALUES ('f${i}.md', 'summary ${i}');`);
  }
  db.close();
  return legacy;
}

function rowCount(path: string): number {
  const db = new DatabaseSync(path);
  try {
    return (db.prepare('SELECT count(*) AS n FROM summaries').get() as { n: number }).n;
  } finally {
    db.close();
  }
}

describe('migrateWorkspaceIndexes', () => {
  it("moves a folder's index home-side with its model output intact and leaves the folder clean", async () => {
    const legacy = await seedLegacyIndex(5);
    const target = projectContentIndexDbFile(home, 'p1', ws);

    const results = await migrateWorkspaceIndexes({ store: storeWith([{ id: 'p1' }]), home });

    expect(results).toEqual([{ projectId: 'p1', outcome: 'moved' }]);
    expect(rowCount(target)).toBe(5);
    expect(existsSync(legacy)).toBe(false);
    expect(await readdir(ws)).toEqual([]);
  });

  it("keeps a person's own files under .gezel/", async () => {
    await seedLegacyIndex();
    await writeFile(join(ws, '.gezel', 'crew.md'), 'ours\n');

    await migrateWorkspaceIndexes({ store: storeWith([{ id: 'p1' }]), home });

    expect(await readdir(join(ws, '.gezel'))).toEqual(['crew.md']);
  });

  it('keeps an existing home-side index and drops the stale folder copy', async () => {
    await seedLegacyIndex(5);
    const target = projectContentIndexDbFile(home, 'p1', ws);
    await mkdir(join(target, '..'), { recursive: true });
    const current = new DatabaseSync(target);
    current.exec('CREATE TABLE summaries (path TEXT, text TEXT);');
    current.exec("INSERT INTO summaries VALUES ('only.md', 'current');");
    current.close();

    const results = await migrateWorkspaceIndexes({ store: storeWith([{ id: 'p1' }]), home });

    expect(results).toEqual([{ projectId: 'p1', outcome: 'cleaned' }]);
    expect(rowCount(target)).toBe(1);
    expect(existsSync(join(ws, '.gezel'))).toBe(false);
  });

  it('snapshots an index another process holds open, then removes the original once free', async () => {
    const legacy = await seedLegacyIndex(4);
    const holder = new DatabaseSync(legacy);
    holder.exec('PRAGMA journal_mode=WAL;');
    holder.prepare('SELECT count(*) FROM summaries').get();
    const target = projectContentIndexDbFile(home, 'p1', ws);

    try {
      const first = await migrateWorkspaceIndexes({ store: storeWith([{ id: 'p1' }]), home });
      expect(first).toEqual([{ projectId: 'p1', outcome: 'copied' }]);
      expect(rowCount(target)).toBe(4);
      expect(existsSync(legacy)).toBe(true);
    } finally {
      holder.close();
    }

    const second = await migrateWorkspaceIndexes({ store: storeWith([{ id: 'p1' }]), home });
    expect(second).toEqual([{ projectId: 'p1', outcome: 'cleaned' }]);
    expect(existsSync(legacy)).toBe(false);
    expect(rowCount(target)).toBe(4);
  });

  it('leaves the shared library and folders without a legacy index alone', async () => {
    await seedLegacyIndex();
    const library = { id: 'shared', properties: { [SHARED_PROJECT_MARKER]: '1' } };

    expect(await migrateWorkspaceIndexes({ store: storeWith([library]), home })).toEqual([]);
    expect(existsSync(projectLocalIndexDbFile(ws))).toBe(true);

    await rm(join(ws, '.gezel'), { recursive: true });
    expect(await migrateWorkspaceIndexes({ store: storeWith([{ id: 'p1' }]), home })).toEqual([]);
  });
});
