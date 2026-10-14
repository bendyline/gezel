import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { SHARED_PROJECT_MARKER } from '@bendyline/gezel';
import { projectContentIndexDbFile, projectLocalIndexDbFile } from '@bendyline/gezel/paths';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrateWorkspaceIndexes } from './index-placement.js';
import { IndexStore } from './index-store.js';

const fsFaults = vi.hoisted(() => ({
  /** `rename(from, …)` of this path fails with this code. */
  renameFrom: null as null | { path: string; code: string },
  /** `rm` of this path fails with this code. */
  rmPath: null as null | { path: string; code: string },
  /** Paths whose handle was synced, in order. */
  synced: [] as string[],
  /** Every rename that ran, in order. */
  renames: [] as Array<[string, string]>,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    rename: async (from: string, to: string) => {
      const fault = fsFaults.renameFrom;
      if (fault && String(from) === fault.path) {
        throw Object.assign(new Error(`${fault.code}: simulated, rename '${from}'`), {
          code: fault.code,
        });
      }
      fsFaults.renames.push([String(from), String(to)]);
      return real.rename(from, to);
    },
    rm: async (...args: Parameters<typeof real.rm>) => {
      const fault = fsFaults.rmPath;
      if (fault && String(args[0]) === fault.path) {
        throw Object.assign(new Error(`${fault.code}: simulated, rm '${args[0]}'`), {
          code: fault.code,
        });
      }
      return real.rm(...args);
    },
    open: async (...args: Parameters<typeof real.open>) => {
      const handle = await real.open(...args);
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        fsFaults.synced.push(String(args[0]));
        return sync();
      };
      return handle;
    },
  };
});

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
  fsFaults.renameFrom = null;
  fsFaults.rmPath = null;
  fsFaults.synced = [];
  fsFaults.renames = [];
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

const boot = () => migrateWorkspaceIndexes({ store: storeWith([{ id: 'p1' }]), home });

/** A legacy index as earlier builds left it: WAL mode, with uncheckpointed rows. */
async function seedLegacyIndex(rows = 3): Promise<string> {
  const legacy = projectLocalIndexDbFile(ws);
  await mkdir(join(ws, '.gezel', 'index'), { recursive: true });
  await writeFile(join(ws, '.gezel', 'index', '.gitignore'), '*\n');
  seedSummaries(legacy, rows, 'folder');
  return legacy;
}

/** A home-side index with `rows` summaries, as a build in between would have written. */
async function seedHomeIndex(rows: number): Promise<string> {
  const target = projectContentIndexDbFile(home, 'p1', ws);
  await mkdir(dirname(target), { recursive: true });
  seedSummaries(target, rows, 'home');
  return target;
}

function seedSummaries(path: string, rows: number, origin: string): void {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
  db.exec('CREATE TABLE IF NOT EXISTS summaries (path TEXT, text TEXT);');
  for (let i = 0; i < rows; i++) {
    db.exec(`INSERT INTO summaries VALUES ('f${i}.md', '${origin} summary ${i}');`);
  }
  db.close();
}

/** What a boot whose move failed or was skipped leaves: the index open minted an empty one. */
async function openEmptyHomeIndex(): Promise<string> {
  const target = projectContentIndexDbFile(home, 'p1', ws);
  const index = await IndexStore.open(target, {
    collectionId: 'p1',
    kind: 'workspace',
    rootPath: ws,
  });
  index!.close();
  return target;
}

function count(path: string, table = 'summaries'): number {
  const db = new DatabaseSync(path);
  try {
    const exists = db
      .prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = '${table}'`)
      .get() as { n: number };
    if (!exists.n) return 0;
    return (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
  } finally {
    db.close();
  }
}

function origin(path: string): string {
  const db = new DatabaseSync(path);
  try {
    const row = db.prepare('SELECT text FROM summaries LIMIT 1').get() as { text: string };
    return row.text.split(' ')[0]!;
  } finally {
    db.close();
  }
}

/** Another process's connection, as an older build or a sync client would hold it. */
function holdOpen(path: string): Db {
  const holder = new DatabaseSync(path);
  holder.exec('PRAGMA journal_mode=WAL;');
  holder.prepare('SELECT count(*) FROM summaries').get();
  return holder;
}

/** Face clusters with one member each and their person entities, on any copy. */
function seedFaces(
  path: string,
  people: Array<{ cluster: string; person: string; direction: number; forgotten?: boolean }>,
): void {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE IF NOT EXISTS face_clusters (id TEXT PRIMARY KEY, collection_id TEXT NOT NULL,
    centroid BLOB, size INTEGER DEFAULT 0, exemplar_hash TEXT, exemplar_face INTEGER, state TEXT, updated_at TEXT);
  CREATE TABLE IF NOT EXISTS face_vectors (content_hash TEXT NOT NULL, face_index INTEGER NOT NULL,
    collection_id TEXT NOT NULL, file_path TEXT NOT NULL, region TEXT, quality REAL, cluster_id TEXT,
    vec BLOB, created_at TEXT, PRIMARY KEY (content_hash, face_index));
  CREATE TABLE IF NOT EXISTS entities (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, label TEXT, canonical TEXT);
  CREATE TABLE IF NOT EXISTS entity_mentions (entity_id INTEGER NOT NULL, collection_id TEXT NOT NULL,
    file_path TEXT NOT NULL, line INTEGER, region TEXT, confidence REAL);`);
  for (const p of people) {
    const v = new Float32Array(8);
    v[p.direction] = 1;
    const hex = Buffer.from(v.buffer).toString('hex');
    db.exec(`INSERT INTO face_clusters (id, collection_id, centroid, size, state)
      VALUES ('${p.cluster}', 'p1', X'${hex}', 1, ${p.forgotten ? "'forgotten'" : 'NULL'});`);
    db.exec(`INSERT INTO face_vectors (content_hash, face_index, collection_id, file_path, cluster_id, vec)
      VALUES ('h-${p.cluster}', 0, 'p1', '${p.cluster}.jpg', '${p.cluster}', X'${hex}');`);
    if (!p.forgotten) {
      db.exec(
        `INSERT INTO entities (kind, label, canonical) VALUES ('person', '${p.person}', '${p.cluster}');`,
      );
      db.exec(`INSERT INTO entity_mentions (entity_id, collection_id, file_path)
        VALUES (last_insert_rowid(), 'p1', '${p.cluster}.jpg');`);
    }
  }
  db.close();
}

function people(path: string): string[] {
  const db = new DatabaseSync(path) as unknown as {
    prepare(sql: string): { all(): Array<{ label: string }> };
    close(): void;
  };
  try {
    return db
      .prepare("SELECT label FROM entities WHERE kind = 'person' ORDER BY label")
      .all()
      .map((r) => r.label);
  } finally {
    db.close();
  }
}

function clusterStates(path: string): Record<string, string | null> {
  const db = new DatabaseSync(path) as unknown as {
    prepare(sql: string): { all(): Array<{ id: string; state: string | null }> };
    close(): void;
  };
  try {
    return Object.fromEntries(
      db
        .prepare('SELECT id, state FROM face_clusters ORDER BY id')
        .all()
        .map((r) => [r.id, r.state]),
    );
  } finally {
    db.close();
  }
}

async function homeIndexFiles(): Promise<string[]> {
  return (await readdir(dirname(projectContentIndexDbFile(home, 'p1', ws)))).sort();
}

describe('migrateWorkspaceIndexes', () => {
  it("moves a folder's index home-side with its model output intact and leaves the folder clean", async () => {
    const legacy = await seedLegacyIndex(5);
    const target = projectContentIndexDbFile(home, 'p1', ws);

    const results = await boot();

    expect(results).toEqual([{ projectId: 'p1', outcome: 'moved' }]);
    expect(count(target)).toBe(5);
    expect(existsSync(legacy)).toBe(false);
    expect(await readdir(ws)).toEqual([]);
  });

  it("keeps a person's own files under .gezel/", async () => {
    await seedLegacyIndex();
    await writeFile(join(ws, '.gezel', 'crew.md'), 'ours\n');

    await boot();

    expect(await readdir(join(ws, '.gezel'))).toEqual(['crew.md']);
  });

  it('keeps a richer home-side index live and preserves the stale folder copy home-side', async () => {
    const legacy = await seedLegacyIndex(1);
    const target = await seedHomeIndex(5);

    const [result] = await boot();

    expect(result).toMatchObject({ projectId: 'p1', outcome: 'cleaned' });
    expect(count(target)).toBe(5);
    expect(origin(target)).toBe('home');
    const preserved = result!.preservedAs!;
    expect(dirname(preserved)).toBe(dirname(target));
    expect(preserved).toMatch(/index\.db\.superseded-/);
    expect(count(preserved)).toBe(1);
    expect(origin(preserved)).toBe('folder');
    expect(existsSync(legacy)).toBe(false);
    expect(existsSync(join(ws, '.gezel'))).toBe(false);
  });

  it('lets a rich folder copy replace an empty home-side index, keeping the empty one', async () => {
    const legacy = await seedLegacyIndex(5);
    const target = await openEmptyHomeIndex();

    const [result] = await boot();

    expect(result).toMatchObject({ projectId: 'p1', outcome: 'replaced' });
    expect(count(target)).toBe(5);
    expect(origin(target)).toBe('folder');
    const preserved = result!.preservedAs!;
    expect(dirname(preserved)).toBe(dirname(target));
    expect(count(preserved)).toBe(0);
    expect(count(preserved, 'collections')).toBe(1);
    expect(existsSync(legacy)).toBe(false);
    expect(await readdir(ws)).toEqual([]);
    // Nothing of the old home-side copy is left beside the new live file for
    // SQLite to replay into it.
    expect(await homeIndexFiles()).toEqual([
      'index.db',
      preserved.slice(dirname(preserved).length + 1),
    ]);
  });

  it('weighs model work over the static index, and indexed files only on a tie', async () => {
    const legacy = await seedLegacyIndex(0);
    const db = new DatabaseSync(legacy);
    db.exec('CREATE TABLE files (path TEXT);');
    db.exec("INSERT INTO files VALUES ('a.md'), ('b.md');");
    db.close();
    const target = await openEmptyHomeIndex();

    const [result] = await boot();

    expect(result).toMatchObject({ outcome: 'replaced' });
    expect(count(target, 'files')).toBe(2);
    expect(count(result!.preservedAs!, 'collections')).toBe(1);
  });

  it('loses nothing when a boot fails to move the folder copy and the next boot succeeds', async () => {
    const legacy = await seedLegacyIndex(6);
    // Boot 1: the folder copy cannot be renamed (Windows EBUSY/EPERM).
    fsFaults.renameFrom = { path: legacy, code: 'EPERM' };
    expect(await boot()).toEqual([{ projectId: 'p1', outcome: 'failed' }]);
    expect(count(legacy)).toBe(6);
    // The rest of that boot opens the index, which mints an empty one home-side.
    const target = await openEmptyHomeIndex();

    // Boot 2: the move fails again, after the empty copy had been set aside.
    // It is put back and the folder copy is untouched.
    expect(await boot()).toEqual([{ projectId: 'p1', outcome: 'failed' }]);
    expect(count(legacy)).toBe(6);
    expect(count(target, 'collections')).toBe(1);
    expect(await homeIndexFiles()).toEqual(['index.db']);

    // Boot 3: the file is free.
    fsFaults.renameFrom = null;
    const [result] = await boot();
    expect(result).toMatchObject({ outcome: 'replaced' });
    expect(count(target)).toBe(6);
    expect(count(result!.preservedAs!, 'collections')).toBe(1);
    expect(existsSync(legacy)).toBe(false);
  });

  it('copies across volumes durably before removing the folder copy', async () => {
    const legacy = await seedLegacyIndex(4);
    const target = projectContentIndexDbFile(home, 'p1', ws);
    fsFaults.renameFrom = { path: legacy, code: 'EXDEV' };

    expect(await boot()).toEqual([{ projectId: 'p1', outcome: 'moved' }]);

    expect(count(target)).toBe(4);
    expect(existsSync(legacy)).toBe(false);
    expect(await readdir(ws)).toEqual([]);
    const staging = `${target}.migrating`;
    expect(existsSync(staging)).toBe(false);
    // The copy is synced before it takes its name, and the rename is synced
    // too, before the original goes.
    expect(fsFaults.synced).toContain(staging);
    expect(fsFaults.synced).toContain(dirname(target));
    expect(fsFaults.renames).toContainEqual([staging, target]);
  });

  it('preserves the folder copy across volumes when the home-side copy wins', async () => {
    const legacy = await seedLegacyIndex(1);
    const target = await seedHomeIndex(3);
    fsFaults.renameFrom = { path: legacy, code: 'EXDEV' };

    const [result] = await boot();

    expect(result).toMatchObject({ outcome: 'cleaned' });
    expect(count(result!.preservedAs!)).toBe(1);
    expect(count(target)).toBe(3);
    expect(existsSync(legacy)).toBe(false);
    expect(fsFaults.synced).toContain(`${target}.migrating`);
  });

  it('snapshots an index another process holds open, then preserves the original once free', async () => {
    const legacy = await seedLegacyIndex(4);
    const holder = new DatabaseSync(legacy);
    holder.exec('PRAGMA journal_mode=WAL;');
    holder.prepare('SELECT count(*) FROM summaries').get();
    const target = projectContentIndexDbFile(home, 'p1', ws);

    try {
      const first = await boot();
      expect(first).toEqual([{ projectId: 'p1', outcome: 'copied' }]);
      expect(count(target)).toBe(4);
      expect(existsSync(legacy)).toBe(true);
    } finally {
      holder.close();
    }

    const [second] = await boot();
    expect(second).toMatchObject({ projectId: 'p1', outcome: 'cleaned' });
    expect(existsSync(legacy)).toBe(false);
    expect(count(target)).toBe(4);
    expect(count(second!.preservedAs!)).toBe(4);
  });

  it('never lets a folder copy held elsewhere replace a home-side index', async () => {
    const legacy = await seedLegacyIndex(4);
    const target = await seedHomeIndex(1);
    const holder = holdOpen(legacy);

    try {
      expect(await boot()).toEqual([{ projectId: 'p1', outcome: 'left-in-place' }]);
      expect(await boot()).toEqual([{ projectId: 'p1', outcome: 'left-in-place' }]);
      expect(origin(target)).toBe('home');
      expect(count(target)).toBe(1);
      expect(count(legacy)).toBe(4);
      expect(await homeIndexFiles()).toEqual(['index.db']);
    } finally {
      holder.close();
    }
  });

  it('keeps a home-side index made from an unchanged folder copy, even after its counts fall', async () => {
    const legacy = await seedLegacyIndex(4);
    const target = projectContentIndexDbFile(home, 'p1', ws);
    const holder = holdOpen(legacy);
    try {
      expect(await boot()).toEqual([{ projectId: 'p1', outcome: 'copied' }]);
    } finally {
      holder.close();
    }
    // The live index loses rows the frozen folder copy still has.
    const live = new DatabaseSync(target);
    live.exec("DELETE FROM summaries WHERE path <> 'f0.md'");
    live.exec("INSERT INTO summaries VALUES ('new.md', 'home summary new');");
    live.close();

    const [result] = await boot();

    expect(result).toMatchObject({ outcome: 'cleaned' });
    expect(count(target)).toBe(2);
    expect(count(result!.preservedAs!)).toBe(4);
    expect(existsSync(legacy)).toBe(false);
  });

  it('compares work again once the folder copy changed after its snapshot', async () => {
    const legacy = await seedLegacyIndex(2);
    const target = projectContentIndexDbFile(home, 'p1', ws);
    const holder = holdOpen(legacy);
    try {
      expect(await boot()).toEqual([{ projectId: 'p1', outcome: 'copied' }]);
      // The other process keeps working on the folder copy.
      holder.exec("INSERT INTO summaries VALUES ('more.md', 'folder summary more');");
      holder.exec("INSERT INTO summaries VALUES ('most.md', 'folder summary most');");
    } finally {
      holder.close();
    }

    const [result] = await boot();

    expect(result).toMatchObject({ outcome: 'replaced' });
    expect(count(target)).toBe(4);
    expect(count(result!.preservedAs!)).toBe(2);
  });

  it('drops its own copy when the folder copy cannot be removed after a cross-volume copy', async () => {
    const legacy = await seedLegacyIndex(1);
    const target = await seedHomeIndex(3);
    fsFaults.renameFrom = { path: legacy, code: 'EXDEV' };
    fsFaults.rmPath = { path: legacy, code: 'EBUSY' };

    expect(await boot()).toEqual([{ projectId: 'p1', outcome: 'left-in-place' }]);
    expect(await boot()).toEqual([{ projectId: 'p1', outcome: 'left-in-place' }]);

    expect(await homeIndexFiles()).toEqual(['index.db']);
    expect(count(target)).toBe(3);
    expect(count(legacy)).toBe(1);
  });

  it('keeps a cross-volume copy whose source stays, and never lets that source revert it', async () => {
    const legacy = await seedLegacyIndex(4);
    const target = projectContentIndexDbFile(home, 'p1', ws);
    fsFaults.renameFrom = { path: legacy, code: 'EXDEV' };
    fsFaults.rmPath = { path: legacy, code: 'EBUSY' };

    expect(await boot()).toEqual([{ projectId: 'p1', outcome: 'copied' }]);
    expect(count(target)).toBe(4);
    expect(count(legacy)).toBe(4);
    const live = new DatabaseSync(target);
    live.exec("DELETE FROM summaries WHERE path <> 'f0.md'");
    live.close();

    expect(await boot()).toEqual([{ projectId: 'p1', outcome: 'left-in-place' }]);
    expect(await homeIndexFiles()).toEqual(['index.db']);
    fsFaults.rmPath = null;
    const [result] = await boot();
    expect(result).toMatchObject({ outcome: 'cleaned' });
    expect(count(target)).toBe(1);
    expect(existsSync(legacy)).toBe(false);
  });

  it('moves a folder copy SQLite cannot read home-side, writing nothing in the folder', async () => {
    const legacy = projectLocalIndexDbFile(ws);
    await mkdir(dirname(legacy), { recursive: true });
    await writeFile(legacy, 'not a database, but someone may want it');

    const [result] = await boot();

    expect(result).toMatchObject({ outcome: 'quarantined' });
    expect(await readdir(ws)).toEqual([]);
    expect(dirname(result!.preservedAs!)).toBe(dirname(projectContentIndexDbFile(home, 'p1', ws)));
    expect(await readFile(result!.preservedAs!, 'utf8')).toBe(
      'not a database, but someone may want it',
    );
    expect(existsSync(projectContentIndexDbFile(home, 'p1', ws))).toBe(false);
  });

  it('carries a wipe of face data across to the copy that goes live', async () => {
    const legacy = await seedLegacyIndex(5);
    seedFaces(legacy, [{ cluster: 'c-folder', person: 'Alice', direction: 0 }]);
    const target = await openEmptyHomeIndex();
    const index = await IndexStore.open(target, {
      collectionId: 'p1',
      kind: 'workspace',
      rootPath: ws,
    });
    index!.wipeFaceData();
    index!.close();

    const [result] = await boot();

    expect(result).toMatchObject({ outcome: 'replaced' });
    expect(count(target)).toBe(5);
    expect(count(target, 'face_vectors')).toBe(0);
    expect(count(target, 'face_clusters')).toBe(0);
    expect(count(target, 'entities')).toBe(0);
  });

  it('carries a forgotten person to the other copy, matched by face when ids differ', async () => {
    const legacy = await seedLegacyIndex(1);
    seedFaces(legacy, [{ cluster: 'c-folder-a', person: 'Alice', direction: 0, forgotten: true }]);
    const target = await seedHomeIndex(5);
    seedFaces(target, [
      { cluster: 'c-home-a', person: 'Alice', direction: 0 },
      { cluster: 'c-home-b', person: 'Bram', direction: 1 },
    ]);

    const [result] = await boot();

    expect(result).toMatchObject({ outcome: 'cleaned' });
    expect(people(target)).toEqual(['Bram']);
    expect(clusterStates(target)).toEqual({ 'c-home-a': 'forgotten', 'c-home-b': null });
  });

  it('keeps only the newest set-aside copy across boots', async () => {
    await seedLegacyIndex(1);
    await seedHomeIndex(5);
    const [first] = await boot();
    await seedLegacyIndex(2);
    const [second] = await boot();

    const files = await homeIndexFiles();
    expect(files).toContain(second!.preservedAs!.slice(dirname(second!.preservedAs!).length + 1));
    expect(existsSync(first!.preservedAs!)).toBe(false);
    expect(files.filter((f) => f.includes('superseded'))).toHaveLength(1);
  });

  it('leaves a held folder copy alone when the home-side index holds more', async () => {
    const legacy = await seedLegacyIndex(1);
    const target = await seedHomeIndex(4);
    const holder = new DatabaseSync(legacy);
    holder.exec('PRAGMA journal_mode=WAL;');
    holder.prepare('SELECT count(*) FROM summaries').get();

    try {
      expect(await boot()).toEqual([{ projectId: 'p1', outcome: 'left-in-place' }]);
      expect(count(legacy)).toBe(1);
      expect(count(target)).toBe(4);
      expect(await homeIndexFiles()).toEqual(['index.db']);
    } finally {
      holder.close();
    }
  });

  it('leaves both copies alone when the poorer home-side index is in use', async () => {
    const legacy = await seedLegacyIndex(4);
    const target = await seedHomeIndex(1);
    const holder = new DatabaseSync(target);
    holder.exec('PRAGMA journal_mode=WAL;');
    holder.prepare('SELECT count(*) FROM summaries').get();

    try {
      expect(await boot()).toEqual([{ projectId: 'p1', outcome: 'left-in-place' }]);
      expect(count(legacy)).toBe(4);
      expect(count(target)).toBe(1);
    } finally {
      holder.close();
    }
  });

  it('leaves the shared library and folders without a legacy index alone', async () => {
    await seedLegacyIndex();
    const library = { id: 'shared', properties: { [SHARED_PROJECT_MARKER]: '1' } };

    expect(await migrateWorkspaceIndexes({ store: storeWith([library]), home })).toEqual([]);
    expect(existsSync(projectLocalIndexDbFile(ws))).toBe(true);

    await rm(join(ws, '.gezel'), { recursive: true });
    expect(await boot()).toEqual([]);
  });
});
