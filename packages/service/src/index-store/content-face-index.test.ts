/**
 * Face tier through ContentIndex.faceIndex with an injected detector (the
 * production path differs only in calling the worker-backed stack): gate
 * semantics, person materialization, and the outage path.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../fs/store.js';
import type { FaceDetectOutcome, FaceModelPaths } from '../memory/image-embeddings.js';
import { ContentIndex } from './content-index.js';
import { runWorkspaceContentIndex } from './content-indexer.js';
import { CLUSTER_MIN_SIZE } from './face/constants.js';

let dir: string;
let home: string;
let artifacts: string;
let ci: ContentIndex;

const PNG_800x600 = Buffer.concat([
  Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x03, 0x20, 0x00, 0x00, 0x02, 0x58, 0x08, 0x02, 0x00, 0x00, 0x00,
  ]),
  Buffer.alloc(8),
]);

const MODELS: FaceModelPaths = { detector: 'unused', embedder: 'unused' };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gezel-facetier-'));
  home = await mkdtemp(join(tmpdir(), 'gezel-facetier-home-'));
  artifacts = join(home, 'artifacts');
  ci = new ContentIndex(
    {
      projectWorkspaceDir: async () => dir,
      projectArtifactsDir: () => artifacts,
    } as unknown as Store,
    home,
  );
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

function sameFaceEverywhere(): (
  jobs: Array<{ path: string; hash: string }>,
) => Promise<FaceDetectOutcome[]> {
  const vec = (() => {
    const v = new Array(8).fill(0);
    v[0] = 1;
    return v;
  })();
  return async (jobs) =>
    jobs.map((j) => ({
      hash: j.hash,
      faces: [
        {
          faceIndex: 0,
          region: { x: 10, y: 10, w: 120, h: 120 },
          score: 0.95,
          quality: 0.9,
          vector: vec,
        },
      ],
    }));
}

describe('face tier (mock detector)', () => {
  it('detects, clusters, and materializes a Person entity across images', async () => {
    await mkdir(join(dir, 'photos'), { recursive: true });
    for (let i = 0; i < CLUSTER_MIN_SIZE; i++) {
      await writeFile(
        join(dir, 'photos', `p${i}.png`),
        Buffer.concat([PNG_800x600, Buffer.from([i])]),
      );
    }
    await runWorkspaceContentIndex(dir, 'p', artifacts);

    const r = await ci.faceIndex('p', 10, { detect: sameFaceEverywhere(), models: MODELS });
    expect(r).toMatchObject({
      files: CLUSTER_MIN_SIZE,
      faces: CLUSTER_MIN_SIZE,
      unavailable: false,
    });

    const entities = await ci.findEntity('p', { kind: 'person' });
    expect(entities.entities).toHaveLength(1);
    expect(entities.entities[0]!.label).toBe('Person 1');
    expect(entities.entities[0]!.mentions).toBe(CLUSTER_MIN_SIZE);

    // Gate consumed — a second batch has nothing to do (detector not called).
    let called = 0;
    const second = await ci.faceIndex('p', 10, {
      detect: async () => {
        called++;
        return [];
      },
      models: MODELS,
    });
    expect(second).toMatchObject({ files: 0, faces: 0 });
    expect(called).toBe(0);
  });

  it('lists, renames, forgets people; wipe erases everything', async () => {
    await mkdir(join(dir, 'photos'), { recursive: true });
    for (let i = 0; i < CLUSTER_MIN_SIZE; i++) {
      await writeFile(
        join(dir, 'photos', `p${i}.png`),
        Buffer.concat([PNG_800x600, Buffer.from([i])]),
      );
    }
    await runWorkspaceContentIndex(dir, 'p', artifacts);
    await ci.faceIndex('p', 10, { detect: sameFaceEverywhere(), models: MODELS });

    const listed = await ci.listPeople('p');
    expect(listed.available).toBe(true);
    expect(listed.people).toHaveLength(1);
    const person = listed.people[0]!;
    expect(person.label).toBe('Person 1');
    expect(person.count).toBe(CLUSTER_MIN_SIZE);
    expect(person.samples.length).toBeGreaterThan(0);
    expect(person.samples[0]!.region).toMatchObject({ x: 10, y: 10, w: 120, h: 120 });
    expect(person.exemplar?.path).toBeTruthy();

    expect(await ci.renamePerson('p', person.entityId, 'Judy')).toBe(true);
    expect((await ci.listPeople('p')).people[0]!.label).toBe('Judy');

    expect(await ci.forgetPerson('p', person.entityId)).toBe(true);
    expect((await ci.listPeople('p')).people).toHaveLength(0);
    // Forget tombstones — face vectors survive for silent absorption.
    expect(await ci.wipeAllFaceData(['p'])).toBe(1);
    const after = await ci.listPeople('p');
    expect(after.people).toHaveLength(0);
  });

  it('stops the drain on a detector outage without burning attempt budgets', async () => {
    await writeFile(join(dir, 'a.png'), PNG_800x600);
    await runWorkspaceContentIndex(dir, 'p', artifacts);
    const r = await ci.faceIndex('p', 10, {
      detect: async () => {
        throw new Error('face model unloadable');
      },
      models: MODELS,
    });
    expect(r).toMatchObject({ faces: 0, unavailable: true });
  });

  it('reports unavailable when no models are installed — and never downloads', async () => {
    await writeFile(join(dir, 'a.png'), PNG_800x600);
    await runWorkspaceContentIndex(dir, 'p', artifacts);
    // faceIndex never touches the network: with no deps.models and no
    // engines/face-models tree in the temp home, it must return unavailable
    // fast (the manager owns the one-time opt-in download).
    const r = await ci.faceIndex('p', 10, {
      detect: async () => [],
      // models deliberately omitted
    });
    expect(r?.unavailable).toBe(true);
  });
});
