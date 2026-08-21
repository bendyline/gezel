/**
 * Pure post-processing for the YuNet 2023mar face detector (OpenCV Zoo, MIT).
 *
 * The fixed 640×640 ONNX emits, per stride s ∈ {8, 16, 32}, flat per-cell
 * tensors over an (640/s)² grid: cls [N,1], obj [N,1], bbox [N,4] and five
 * landmarks kps [N,10]. Decode follows OpenCV's FaceDetectorYN: score is
 * √(cls·obj); box center is (col + dx)·s, (row + dy)·s with exp-scaled
 * width/height; landmarks are per-cell offsets in the same grid space. All
 * pure math over Float32Arrays — unit-testable with canned tensors.
 */

import { FACE_DETECT_SCORE, FACE_NMS_IOU } from './constants.js';

export const YUNET_INPUT = 640;
export const YUNET_STRIDES = [8, 16, 32] as const;

export interface DetectedFace {
  /** Box in MODEL space (letterboxed 640² px); caller scales back to source. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Five landmarks (eyes, nose, mouth corners) as [x0,y0,...,x4,y4]. */
  landmarks: number[];
  score: number;
}

export interface YunetOutputs {
  /** Keyed by stride: cls_8, obj_8, bbox_8, kps_8, ... as flat Float32Arrays. */
  [name: string]: Float32Array;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Decode raw YuNet outputs into scored candidate faces (before NMS). */
export function decodeYunetGrid(
  outputs: YunetOutputs,
  scoreThreshold = FACE_DETECT_SCORE,
): DetectedFace[] {
  const faces: DetectedFace[] = [];
  for (const stride of YUNET_STRIDES) {
    const cls = outputs[`cls_${stride}`];
    const obj = outputs[`obj_${stride}`];
    const bbox = outputs[`bbox_${stride}`];
    const kps = outputs[`kps_${stride}`];
    if (!cls || !obj || !bbox || !kps) continue;
    const cols = YUNET_INPUT / stride;
    for (let i = 0; i < cls.length; i++) {
      const score = Math.sqrt(clamp01(cls[i]!) * clamp01(obj[i]!));
      if (score < scoreThreshold) continue;
      const row = Math.floor(i / cols);
      const col = i % cols;
      const cx = (col + bbox[i * 4]!) * stride;
      const cy = (row + bbox[i * 4 + 1]!) * stride;
      const w = Math.exp(bbox[i * 4 + 2]!) * stride;
      const h = Math.exp(bbox[i * 4 + 3]!) * stride;
      const landmarks: number[] = [];
      for (let k = 0; k < 5; k++) {
        landmarks.push(
          (col + kps[i * 10 + k * 2]!) * stride,
          (row + kps[i * 10 + k * 2 + 1]!) * stride,
        );
      }
      faces.push({ x: cx - w / 2, y: cy - h / 2, w, h, landmarks, score });
    }
  }
  return faces;
}

function iou(a: DetectedFace, b: DetectedFace): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.w * a.h + b.w * b.h - inter;
  return union <= 0 ? 0 : inter / union;
}

/** Greedy IoU NMS, highest score first. */
export function nonMaxSuppress(faces: DetectedFace[], iouThreshold = FACE_NMS_IOU): DetectedFace[] {
  const sorted = [...faces].sort((a, b) => b.score - a.score);
  const kept: DetectedFace[] = [];
  for (const f of sorted) {
    if (kept.every((k) => iou(k, f) < iouThreshold)) kept.push(f);
  }
  return kept;
}

/** Full postprocess: decode all strides, then NMS. */
export function postprocessYunet(
  outputs: YunetOutputs,
  scoreThreshold = FACE_DETECT_SCORE,
): DetectedFace[] {
  return nonMaxSuppress(decodeYunetGrid(outputs, scoreThreshold));
}
