import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fallbackProjectIndexDir, projectContentIndexDbFile } from '@bendyline/gezel/paths';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../fs/store.js';
import { ContentIndex } from './content-index.js';
import { IndexStore } from './index-store.js';
import {
  PRESERVED_INDEX_RETENTION_MS,
  fileStamp,
  prunePreservedIndexCopies,
} from './preserved-indexes.js';

const DAY = 24 * 60 * 60 * 1000;
let home: string;
let ws: string;
let indexDir: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-preserved-home-'));
  ws = await mkdtemp(join(tmpdir(), 'gezel-preserved-ws-'));
  indexDir = fallbackProjectIndexDir(home, 'p1');
  await mkdir(indexDir, { recursive: true });
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(ws, { recursive: true, force: true });
});

async function touch(...names: string[]): Promise<void> {
  for (const name of names) await writeFile(join(indexDir, name), name);
}

describe('prunePreservedIndexCopies', () => {
  const now = Date.parse('2026-10-14T12:00:00.000Z');
  const ago = (days: number) => fileStamp(new Date(now - days * DAY));

  it('keeps the newest superseded copy and anything younger than the retention, nothing else', async () => {
    await touch(
      'index.db',
      'index.db-wal',
      'index.db-shm',
      'artifacts.db',
      'artifacts.db.corrupt-1',
      `index.db.superseded-${ago(1)}`,
      `index.db.superseded-${ago(1)}-wal`,
      `index.db.superseded-${ago(2)}`,
      `index.db.superseded-${ago(2)}-shm`,
      `index.db.superseded-${ago(40)}`,
      `index.db.corrupt-${now - 40 * DAY}`,
      `index.db-wal.corrupt-${now - 40 * DAY}`,
      `index.db.corrupt-${now - DAY}`,
      `index.db.orphaned-${ago(40)}-wal`,
      `index.db.orphaned-${ago(3)}-wal`,
      `index.db.superseded-${ago(5)}-1-wal`,
    );

    await prunePreservedIndexCopies(indexDir, now);

    expect((await readdir(indexDir)).sort()).toEqual(
      [
        'artifacts.db',
        'artifacts.db.corrupt-1',
        'index.db',
        'index.db-shm',
        'index.db-wal',
        `index.db.corrupt-${now - DAY}`,
        `index.db.orphaned-${ago(3)}-wal`,
        `index.db.superseded-${ago(1)}`,
        `index.db.superseded-${ago(1)}-wal`,
      ].sort(),
    );
  });

  it('removes even the newest superseded copy once it is past the retention', async () => {
    const days = PRESERVED_INDEX_RETENTION_MS / DAY;
    await touch(
      'index.db',
      `index.db.superseded-${ago(days)}`,
      `index.db.superseded-${ago(days)}-wal`,
    );

    await prunePreservedIndexCopies(indexDir, now);

    expect(await readdir(indexDir)).toEqual(['index.db']);
  });
});

describe('face-data erasure reaches set-aside index copies', () => {
  let ci: ContentIndex;
  const live = () => projectContentIndexDbFile(home, 'p1', ws);
  const openAt = async (path: string) =>
    (await IndexStore.open(path, { collectionId: 'p1', kind: 'workspace', rootPath: ws }))!;
  const unit = (direction: number) => {
    const v = new Float32Array(8);
    v[direction] = 1;
    return v;
  };

  /** One person per entry: a cluster, a member face and a named person entity. */
  async function seedPeople(
    path: string,
    people: Array<{ cluster: string; label: string; direction: number }>,
  ): Promise<Map<string, number>> {
    const index = await openAt(path);
    const ids = new Map<string, number>();
    try {
      for (const p of people) {
        index.upsertFaceCluster({ id: p.cluster, centroid: unit(p.direction), size: 1 });
        index.putFaceVector({
          contentHash: `h-${p.cluster}`,
          faceIndex: 0,
          filePath: `${p.cluster}.jpg`,
          region: '{"x":0,"y":0,"w":50,"h":50}',
          quality: 0.9,
          clusterId: p.cluster,
          vec: unit(p.direction),
        });
        const id = index.upsertEntity('person', p.label, p.cluster);
        index.addEntityMention(id, `${p.cluster}.jpg`);
        ids.set(p.label, id);
      }
    } finally {
      index.close();
    }
    return ids;
  }

  async function facesIn(path: string): Promise<{ faces: number; people: string[] }> {
    const index = await openAt(path);
    try {
      return {
        faces: index.faceVectors().length,
        people: index
          .faceClusters()
          .filter((c) => c.state !== 'forgotten')
          .map((c) => index.entityByCanonical('person', c.id)?.label)
          .filter((l): l is string => Boolean(l))
          .sort(),
      };
    } finally {
      index.close();
    }
  }

  beforeEach(() => {
    ci = new ContentIndex(
      {
        projectWorkspaceDir: async () => ws,
        projectArtifactsDir: () => join(home, 'artifacts'),
      } as unknown as Store,
      home,
    );
  });

  it('a wipe erases the faces and names in a superseded copy and removes unreadable copies', async () => {
    await seedPeople(live(), [{ cluster: 'a', label: 'Alice', direction: 0 }]);
    const superseded = join(indexDir, `index.db.superseded-${fileStamp()}`);
    await copyFile(live(), superseded);
    await seedPeople(superseded, [{ cluster: 'z', label: 'Zora', direction: 3 }]);
    const corrupt = join(indexDir, `index.db.corrupt-${Date.now()}`);
    await writeFile(corrupt, 'unreadable, may hold faces');
    const orphan = join(indexDir, `index.db.orphaned-${fileStamp()}-wal`);
    await writeFile(orphan, 'wal pages');

    expect(await ci.wipeAllFaceData(['p1'])).toBe(1);

    expect(await facesIn(live())).toEqual({ faces: 0, people: [] });
    expect(await facesIn(superseded)).toEqual({ faces: 0, people: [] });
    expect(existsSync(corrupt)).toBe(false);
    expect(existsSync(orphan)).toBe(false);
  });

  it('a wipe still reaches set-aside copies of a project with no live index', async () => {
    const superseded = join(indexDir, `index.db.superseded-${fileStamp()}`);
    await seedPeople(superseded, [{ cluster: 'z', label: 'Zora', direction: 3 }]);
    await rm(live(), { force: true });
    const unopenable: ContentIndex = new ContentIndex(
      {
        projectWorkspaceDir: async () => {
          throw new Error('no such project');
        },
        projectArtifactsDir: () => join(home, 'artifacts'),
      } as unknown as Store,
      home,
    );

    expect(await unopenable.wipeAllFaceData(['p1'])).toBe(0);

    expect(await facesIn(superseded)).toEqual({ faces: 0, people: [] });
  });

  it('forgetting a person forgets them in a superseded copy, found by face when the ids differ', async () => {
    const ids = await seedPeople(live(), [
      { cluster: 'live-a', label: 'Alice', direction: 0 },
      { cluster: 'live-b', label: 'Bram', direction: 1 },
    ]);
    const superseded = join(indexDir, `index.db.superseded-${fileStamp()}`);
    await seedPeople(superseded, [
      { cluster: 'old-a', label: 'Alice (old)', direction: 0 },
      { cluster: 'old-c', label: 'Cas', direction: 2 },
    ]);

    expect(await ci.forgetPerson('p1', ids.get('Alice')!)).toBe(true);

    expect((await facesIn(live())).people).toEqual(['Bram']);
    expect((await facesIn(superseded)).people).toEqual(['Cas']);
  });
});
