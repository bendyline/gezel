/**
 * Face-lane thresholds, in one place with their rationale. Env overrides
 * exist for eval tuning only — the defaults are the product behavior.
 *
 * Cosine bands (ArcFace/AuraFace space): same-identity image PAIRS verify
 * around 0.35–0.45; a face against a cluster CENTROID runs higher because the
 * centroid denoises; centroid-to-centroid higher still. The bias is
 * deliberately prefer-split: a split identity heals via the merge pass or a
 * user rename, while a wrong merge (two people become one "Person") is the
 * worst user-visible error and needs manual forgetting.
 */

function envNum(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/** Assign a face to the nearest cluster only at or above this cosine. */
export const faceAssignThreshold = (): number => envNum('GEZEL_FACE_T_ASSIGN', 0.55);

/** Merge two clusters only when their exact centroids reach this cosine. */
export const faceMergeThreshold = (): number => envNum('GEZEL_FACE_T_MERGE', 0.7);

/** Detector score below this → the face is stored but never clustered. */
export const FACE_MIN_SCORE = 0.7;

/** Face box min side (source px) below this → too small/blurry to cluster. */
export const FACE_MIN_PX = 40;

/** A cluster surfaces as a Person entity only at this many members. */
export const CLUSTER_MIN_SIZE = 3;

/** Raw detection floor — faces below this are not stored at all. */
export const FACE_DETECT_SCORE = 0.6;

/** IoU above which two detections are the same face (NMS). */
export const FACE_NMS_IOU = 0.3;
