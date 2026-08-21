/**
 * Incremental face clustering over synthetic unit vectors: assignment vs new
 * cluster, quality gating, prefer-split, merge behavior with user-named and
 * forgotten clusters, Person-N sequence non-reuse, and forget/wipe semantics.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DetectedFaceResult } from '../../memory/face-embed-core.js';
import { IndexStore } from '../index-store.js';
import { clusterNewFaces, mergeFaceClusters, syncPersonEntities } from './clustering.js';
import { CLUSTER_MIN_SIZE } from './constants.js';

let dir: string;
let store: IndexStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gezel-face-cluster-'));
  store = (await IndexStore.open(join(dir, 'index.db'), {
    collectionId: 'p1',
    kind: 'workspace',
    rootPath: dir,
  }))!;
});
afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

/** Unit vector leaning between two axes: angle 0 → pure `a`, 90° → pure `b`. */
function lean(a: number, b: number, degrees: number, dim = 8): number[] {
  const v = new Array<number>(dim).fill(0);
  const rad = (degrees * Math.PI) / 180;
  v[a] = Math.cos(rad);
  v[b] = Math.sin(rad);
  return v;
}

function face(vector: number[], overrides: Partial<DetectedFaceResult> = {}): DetectedFaceResult {
  return {
    faceIndex: overrides.faceIndex ?? 0,
    region: { x: 0, y: 0, w: 120, h: 120 },
    score: 0.95,
    quality: 0.95,
    vector,
    ...overrides,
  };
}

function seedImage(hash: string, path: string): void {
  store.upsertFile({
    path,
    hash,
    size: 10,
    mtimeMs: 1,
    lang: null,
    kind: 'image',
    modality: 'image',
    trivial: false,
    indexedAt: 'now',
    loc: null,
  });
}

describe('clusterNewFaces', () => {
  it('assigns near faces to one cluster and splits far ones', () => {
    seedImage('h1', 'a.png');
    seedImage('h2', 'b.png');
    seedImage('h3', 'c.png');
    clusterNewFaces(store, 'h1', 'a.png', [face(lean(0, 1, 0))]);
    clusterNewFaces(store, 'h2', 'b.png', [face(lean(0, 1, 20))]); // cos ≈ 0.94 → same person
    clusterNewFaces(store, 'h3', 'c.png', [face(lean(2, 3, 0))]); // orthogonal → new person

    const clusters = store.faceClusters();
    expect(clusters).toHaveLength(2);
    expect(clusters.map((c) => c.size).sort()).toEqual([1, 2]);
  });

  it('below-gate faces are stored unclustered', () => {
    seedImage('h1', 'a.png');
    clusterNewFaces(store, 'h1', 'a.png', [
      face(lean(0, 1, 0), { score: 0.5 }), // below FACE_MIN_SCORE
      face(lean(0, 1, 0), { faceIndex: 1, region: { x: 0, y: 0, w: 20, h: 20 } }), // tiny
    ]);
    expect(store.faceClusters()).toHaveLength(0);
    // Vectors ARE stored (re-clusterable later without re-detecting).
    const raw = store.faceVectors(); // clustered-only view
    expect(raw).toHaveLength(0);
  });
});

describe('mergeFaceClusters', () => {
  function seedTwoNearClusters(): void {
    // Constructed directly (not via sequential assignment): in real 512-d
    // space, drift and arrival order routinely leave two clusters of one
    // identity whose exact centroids agree — the state the merge pass heals.
    // c1: members at 0° and 10°; c2: members at 30° and 40° → centroids
    // ~5° and ~35°, separation 30° (cos ≈ 0.87 ≥ T_MERGE 0.70).
    const groups: Array<{ id: string; degs: number[] }> = [
      { id: 'cluster-a', degs: [0, 10] },
      { id: 'cluster-b', degs: [30, 40] },
    ];
    let n = 0;
    for (const g of groups) {
      for (const deg of g.degs) {
        const hash = `h${n}`;
        seedImage(hash, `${hash}.png`);
        store.putFaceVector({
          contentHash: hash,
          faceIndex: 0,
          filePath: `${hash}.png`,
          region: JSON.stringify({ x: 0, y: 0, w: 120, h: 120 }),
          quality: 0.9,
          clusterId: g.id,
          vec: lean(0, 1, deg),
        });
        n++;
      }
      store.upsertFaceCluster({
        id: g.id,
        centroid: lean(0, 1, (g.degs[0]! + g.degs[1]!) / 2),
        size: g.degs.length,
      });
    }
  }

  it('merges clusters whose exact centroids agree, repointing members', () => {
    seedTwoNearClusters();
    const before = store.faceClusters();
    expect(before.length).toBeGreaterThanOrEqual(2);
    mergeFaceClusters(store);
    const after = store.faceClusters();
    expect(after).toHaveLength(1);
    expect(after[0]!.size).toBe(4);
    expect(new Set(store.faceVectors().map((v) => v.clusterId)).size).toBe(1);
  });

  it('a user-named cluster survives a merge with its label', () => {
    seedTwoNearClusters();
    const clusters = store.faceClusters();
    const smaller = clusters.reduce((a, b) => (b.size < a.size ? b : a));
    const entityId = store.upsertEntity('person', 'Judy', smaller.id);
    expect(store.entityById(entityId)?.label).toBe('Judy');

    mergeFaceClusters(store);
    const surviving = store.faceClusters();
    expect(surviving).toHaveLength(1);
    // The named identity won the merge even though it was smaller.
    expect(surviving[0]!.id).toBe(smaller.id);
    expect(store.entityByCanonical('person', smaller.id)?.label).toBe('Judy');
  });
});

describe('syncPersonEntities', () => {
  it('materializes an entity only at CLUSTER_MIN_SIZE, with region mentions', () => {
    for (let i = 0; i < CLUSTER_MIN_SIZE; i++) {
      const hash = `h${i}`;
      seedImage(hash, `${hash}.png`);
      clusterNewFaces(store, hash, `${hash}.png`, [face(lean(0, 1, i * 3))]);
      syncPersonEntities(store);
      const people = store.findEntities(undefined, { kind: 'person' });
      if (i < CLUSTER_MIN_SIZE - 1) expect(people).toHaveLength(0);
    }
    const people = store.findEntities(undefined, { kind: 'person' });
    expect(people).toHaveLength(1);
    expect(people[0]!.label).toBe('Person 1');
    expect(people[0]!.mentions).toBe(CLUSTER_MIN_SIZE);
    const mentions = store.entityMentions(people[0]!.id);
    expect(mentions.every((m) => m.region && m.confidence != null)).toBe(true);
  });

  it('never reuses a Person number after forgetting', () => {
    // First person reaches the threshold and gets "Person 1".
    for (let i = 0; i < CLUSTER_MIN_SIZE; i++) {
      seedImage(`a${i}`, `a${i}.png`);
      clusterNewFaces(store, `a${i}`, `a${i}.png`, [face(lean(0, 1, i))]);
    }
    syncPersonEntities(store);
    const first = store.findEntities(undefined, { kind: 'person' })[0]!;
    expect(first.label).toBe('Person 1');

    // Forget them: entity deleted, cluster tombstoned.
    const clusterId = store.entityById(first.id)!.canonical;
    store.deleteEntity(first.id);
    store.markFaceClusterForgotten(clusterId);

    // New photos of the SAME person are absorbed silently — no resurrection.
    seedImage('a9', 'a9.png');
    clusterNewFaces(store, 'a9', 'a9.png', [face(lean(0, 1, 2))]);
    syncPersonEntities(store);
    expect(store.findEntities(undefined, { kind: 'person' })).toHaveLength(0);

    // A DIFFERENT person becomes "Person 2" — the number 1 is spent.
    for (let i = 0; i < CLUSTER_MIN_SIZE; i++) {
      seedImage(`b${i}`, `b${i}.png`);
      clusterNewFaces(store, `b${i}`, `b${i}.png`, [face(lean(2, 3, i))]);
    }
    syncPersonEntities(store);
    const people = store.findEntities(undefined, { kind: 'person' });
    expect(people).toHaveLength(1);
    expect(people[0]!.label).toBe('Person 2');
  });

  it('wipeFaceData erases vectors, clusters, gate rows, and person entities', () => {
    for (let i = 0; i < CLUSTER_MIN_SIZE; i++) {
      seedImage(`h${i}`, `h${i}.png`);
      clusterNewFaces(store, `h${i}`, `h${i}.png`, [face(lean(0, 1, i))]);
      store.markFaceOk(`h${i}`, `h${i}.png`, 1);
    }
    syncPersonEntities(store);
    expect(store.findEntities(undefined, { kind: 'person' })).toHaveLength(1);

    store.wipeFaceData();
    expect(store.faceVectors()).toHaveLength(0);
    expect(store.faceClusters()).toHaveLength(0);
    expect(store.findEntities(undefined, { kind: 'person' })).toHaveLength(0);
    // Gate rows gone → the tier would re-detect after a re-enable.
    expect(store.filesNeedingFaceIndex().length).toBe(CLUSTER_MIN_SIZE);
  });
});
