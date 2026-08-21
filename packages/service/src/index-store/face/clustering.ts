/**
 * Incremental face clustering (lane B). Three passes over IndexStore state:
 *
 *   1. clusterNewFaces — store each detected face's vector; quality-gated
 *      faces are assigned to the nearest live centroid at ≥ T_ASSIGN or found
 *      a new cluster (running-mean centroid update, O(K) per face).
 *   2. mergeFaceClusters — recompute EXACT centroids from members (healing
 *      running-mean drift), then merge cluster pairs at ≥ T_MERGE. Prefer-
 *      split bias is deliberate: splits heal here or via a user rename; a
 *      wrong merge needs manual forgetting.
 *   3. syncPersonEntities — clusters of ≥ CLUSTER_MIN_SIZE materialize as
 *      `entities(kind='person')` named "Person N" from a never-reused counter,
 *      with one region-carrying mention per member face. Mentions are rebuilt
 *      idempotently so merges/deletions never leave strays.
 *
 * Tombstones: a 'forgotten' cluster keeps absorbing matching faces (so the
 * person never resurrects as a fresh "Person N") but never re-materializes an
 * entity. The wipe path deletes everything instead.
 */

import { randomUUID } from 'node:crypto';
import type { DetectedFaceResult } from '../../memory/face-embed-core.js';
import type { IndexStore } from '../index-store.js';
import {
  CLUSTER_MIN_SIZE,
  FACE_MIN_PX,
  FACE_MIN_SCORE,
  faceAssignThreshold,
  faceMergeThreshold,
} from './constants.js';

function cosine(a: Float32Array | number[], b: Float32Array | number[]): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  if (a.length !== b.length) return -1;
  for (let i = 0; i < n; i++) s += (a[i] as number) * (b[i] as number);
  return s;
}

function renormalize(v: number[]): number[] {
  let sum = 0;
  for (const x of v) sum += x * x;
  const norm = Math.sqrt(sum);
  return norm > 0 ? v.map((x) => x / norm) : v;
}

function clusterEligible(face: DetectedFaceResult): boolean {
  return face.score >= FACE_MIN_SCORE && Math.min(face.region.w, face.region.h) >= FACE_MIN_PX;
}

/** Store + cluster the faces of one image (already detected + embedded). */
export function clusterNewFaces(
  index: IndexStore,
  contentHash: string,
  filePath: string,
  faces: DetectedFaceResult[],
): void {
  const clusters = index.faceClusters().map((c) => ({
    ...c,
    centroid: c.centroid ? Array.from(c.centroid) : null,
  }));
  const tAssign = faceAssignThreshold();

  for (const face of faces) {
    let clusterId: string | null = null;
    if (clusterEligible(face)) {
      let best: (typeof clusters)[number] | null = null;
      let bestCos = -1;
      for (const c of clusters) {
        if (!c.centroid) continue;
        const cos = cosine(face.vector, c.centroid);
        if (cos > bestCos) {
          bestCos = cos;
          best = c;
        }
      }
      if (best?.centroid && bestCos >= tAssign) {
        clusterId = best.id;
        const merged = renormalize(
          best.centroid.map((v, i) => v * best.size + (face.vector[i] ?? 0)),
        );
        best.centroid = merged;
        best.size += 1;
        index.upsertFaceCluster({
          id: best.id,
          centroid: merged,
          size: best.size,
          exemplarHash: best.exemplarHash,
          exemplarFace: best.exemplarFace,
          state: best.state,
        });
      } else {
        clusterId = randomUUID();
        const fresh = {
          id: clusterId,
          centroid: [...face.vector],
          size: 1,
          exemplarHash: contentHash,
          exemplarFace: face.faceIndex,
          state: null as string | null,
        };
        clusters.push(fresh);
        index.upsertFaceCluster(fresh);
      }
    }
    index.putFaceVector({
      contentHash,
      faceIndex: face.faceIndex,
      filePath,
      region: JSON.stringify(face.region),
      quality: face.quality,
      clusterId,
      vec: face.vector,
    });
  }
}

/** Exact-centroid recompute + pairwise merge at ≥ T_MERGE. */
export function mergeFaceClusters(index: IndexStore): void {
  const members = new Map<string, ReturnType<IndexStore['faceVectors']>>();
  for (const v of index.faceVectors()) {
    if (!v.clusterId) continue;
    const list = members.get(v.clusterId) ?? [];
    list.push(v);
    members.set(v.clusterId, list);
  }

  const clusters = index
    .faceClusters()
    .map((c) => {
      const mem = members.get(c.id) ?? [];
      if (mem.length === 0) return { ...c, centroid: c.centroid ? Array.from(c.centroid) : null };
      const dim = mem[0]!.vec.length;
      const sum = new Array<number>(dim).fill(0);
      for (const m of mem) {
        for (let i = 0; i < dim; i++) sum[i]! += m.vec[i] ?? 0;
      }
      const centroid = renormalize(sum);
      const exemplar = mem.reduce((a, b) => (b.quality > a.quality ? b : a));
      const updated = {
        ...c,
        centroid,
        size: mem.length,
        exemplarHash: exemplar.contentHash,
        exemplarFace: exemplar.faceIndex,
      };
      index.upsertFaceCluster(updated);
      return updated;
    })
    .filter((c) => c.centroid !== null);

  const tMerge = faceMergeThreshold();
  const isUserNamed = (clusterId: string): boolean => {
    const entity = index.entityByCanonical('person', clusterId);
    return Boolean(entity && !/^Person \d+$/.test(entity.label));
  };

  let mergedSomething = true;
  while (mergedSomething) {
    mergedSomething = false;
    outer: for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const a = clusters[i]!;
        const b = clusters[j]!;
        if (!a.centroid || !b.centroid) continue;
        if (cosine(a.centroid, b.centroid) < tMerge) continue;
        // Winner: user-named label > forgotten tombstone > larger membership.
        let winner = a;
        let loser = b;
        const aNamed = isUserNamed(a.id);
        const bNamed = isUserNamed(b.id);
        if (bNamed && !aNamed) [winner, loser] = [b, a];
        else if (aNamed === bNamed) {
          if (b.state === 'forgotten' && a.state !== 'forgotten') [winner, loser] = [b, a];
          else if (a.state === b.state && b.size > a.size) [winner, loser] = [b, a];
        }
        index.reassignFaceCluster(loser.id, winner.id);
        const loserEntity = index.entityByCanonical('person', loser.id);
        if (loserEntity) index.deleteEntity(loserEntity.id);
        index.deleteFaceCluster(loser.id);
        const combined = renormalize(
          winner.centroid!.map((v, k) => v * winner.size + (loser.centroid?.[k] ?? 0) * loser.size),
        );
        winner.centroid = combined;
        winner.size += loser.size;
        index.upsertFaceCluster({
          id: winner.id,
          centroid: combined,
          size: winner.size,
          exemplarHash: winner.exemplarHash,
          exemplarFace: winner.exemplarFace,
          state: winner.state,
        });
        clusters.splice(clusters.indexOf(loser), 1);
        mergedSomething = true;
        break outer;
      }
    }
  }
}

/** Materialize/refresh Person entities + region mentions for big-enough clusters. */
export function syncPersonEntities(index: IndexStore): void {
  const byCluster = new Map<string, ReturnType<IndexStore['faceVectors']>>();
  for (const v of index.faceVectors()) {
    if (!v.clusterId) continue;
    const list = byCluster.get(v.clusterId) ?? [];
    list.push(v);
    byCluster.set(v.clusterId, list);
  }
  for (const cluster of index.faceClusters()) {
    if (cluster.state === 'forgotten') continue;
    const members = byCluster.get(cluster.id) ?? [];
    if (members.length < CLUSTER_MIN_SIZE) continue;
    let entity = index.entityByCanonical('person', cluster.id);
    if (!entity) {
      const id = index.upsertEntity('person', `Person ${index.nextFacePersonSeq()}`, cluster.id);
      entity = index.entityById(id);
    }
    if (!entity) continue;
    index.deleteEntityMentions(entity.id);
    for (const m of members) {
      index.addEntityMention(entity.id, m.filePath, {
        ...(m.region ? { region: m.region } : {}),
        confidence: m.quality,
      });
    }
  }
}
