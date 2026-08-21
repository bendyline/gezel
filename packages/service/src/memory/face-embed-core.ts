/**
 * Face detect + embed core (lane B of image search): YuNet detection and
 * AuraFace (ArcFace-space) embeddings as raw onnxruntime-node
 * InferenceSessions — no transformers.js involvement, no sharp. Runs in the
 * image-embed worker (kind 'faces') or the in-process fallback.
 *
 * Model files are downloaded and sha256-verified HOST-side
 * (index-store/face/catalog.ts); this module only ever receives resolved
 * local paths — a deliberate seam that keeps the worker's import graph free
 * of provider code (see image-embed-containment.test.ts).
 *
 * Pixel conventions, verified against the pinned models:
 *   - YuNet: fixed [1,3,640,640] input, BGR channel order, RAW 0–255 floats
 *     (OpenCV FaceDetectorYN convention) — letterboxed top-left, zero pad.
 *   - AuraFace glintr100: [1,3,112,112] RGB, (x − 127.5) / 127.5, on the
 *     five-point-aligned ArcFace crop; output [1,512], L2-normalized here.
 */

import { createRequire } from 'node:module';
import { ARCFACE_SIZE, alignToArcFace } from '../index-store/face/align.js';
import { FACE_MIN_PX } from '../index-store/face/constants.js';
import { YUNET_INPUT, type YunetOutputs, postprocessYunet } from '../index-store/face/yunet.js';
import { PipelineLoadError } from './embed-core.js';
import {
  ImageDecodeError,
  type RgbImage,
  decodeImage,
  readBoundedImageFile,
  resizeBilinear,
  rgbaToRgb,
} from './image-pixels.js';

/** Structurally identical to the catalog's FaceModelPaths — kept local so
 *  this worker-reachable module never imports the download stack. */
export interface FaceModelPaths {
  detector: string;
  embedder: string;
}

export interface FaceRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DetectedFaceResult {
  faceIndex: number;
  region: FaceRegion;
  score: number;
  /** score × min(1, minSide / 80) — the clustering quality gate input. */
  quality: number;
  /** Unit-norm 512-d ArcFace-space embedding. */
  vector: number[];
}

export type FaceDetectOutcome =
  | { hash: string; faces: DetectedFaceResult[] }
  | { hash: string; skip: 'unsupported' | 'too-large' | 'decode-failed'; detail?: string }
  | { hash: string; error: string };

interface OrtTensor {
  data: Float32Array;
}
interface OrtSession {
  inputNames: string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensor>>;
}
interface OrtModule {
  InferenceSession: { create(path: string): Promise<OrtSession> };
  Tensor: new (type: string, data: Float32Array, dims: number[]) => unknown;
}

let ortPromise: Promise<OrtModule> | null = null;

function loadOrt(): Promise<OrtModule> {
  if (!ortPromise) {
    ortPromise = (async () => {
      try {
        // onnxruntime-node is CJS and arrives alongside the optional
        // @huggingface/transformers peer; createRequire is the deterministic
        // interop (same reasoning as the decoders in image-pixels.ts).
        return createRequire(import.meta.url)('onnxruntime-node') as OrtModule;
      } catch {
        throw new PipelineLoadError(
          'Face recognition needs onnxruntime-node, which installs alongside the optional @huggingface/transformers peer (see the service README).',
          true,
        );
      }
    })();
    ortPromise.catch(() => {
      ortPromise = null;
    });
  }
  return ortPromise;
}

const sessions = new Map<string, Promise<OrtSession>>();

function loadSession(path: string): Promise<OrtSession> {
  let s = sessions.get(path);
  if (!s) {
    s = (async () => {
      const ort = await loadOrt();
      try {
        return await ort.InferenceSession.create(path);
      } catch (err) {
        // A pinned, sha256-verified file that won't load is operator-action
        // territory, not a transient.
        throw new PipelineLoadError(
          `face model failed to load (${path}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    })();
    s.catch(() => sessions.delete(path));
    sessions.set(path, s);
  }
  return s;
}

/** Letterbox (top-left, zero pad) into YuNet's fixed 640² BGR raw-float CHW. */
function yunetInput(rgb: RgbImage): { chw: Float32Array; scale: number } {
  const scale = YUNET_INPUT / Math.max(rgb.width, rgb.height);
  const resized =
    scale < 1
      ? resizeBilinear(
          rgb,
          Math.max(1, Math.round(rgb.width * scale)),
          Math.max(1, Math.round(rgb.height * scale)),
        )
      : rgb;
  const effScale = scale < 1 ? scale : 1;
  const plane = YUNET_INPUT * YUNET_INPUT;
  const chw = new Float32Array(3 * plane);
  for (let y = 0; y < resized.height; y++) {
    for (let x = 0; x < resized.width; x++) {
      const si = (y * resized.width + x) * 3;
      const pi = y * YUNET_INPUT + x;
      chw[pi] = resized.data[si + 2]!; // B
      chw[plane + pi] = resized.data[si + 1]!; // G
      chw[2 * plane + pi] = resized.data[si]!; // R
    }
  }
  return { chw, scale: effScale };
}

/** ArcFace preprocessing on an aligned 112² RGB crop. */
function arcfaceInput(crop: RgbImage): Float32Array {
  const plane = ARCFACE_SIZE * ARCFACE_SIZE;
  const chw = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    chw[i] = (crop.data[i * 3]! - 127.5) / 127.5;
    chw[plane + i] = (crop.data[i * 3 + 1]! - 127.5) / 127.5;
    chw[2 * plane + i] = (crop.data[i * 3 + 2]! - 127.5) / 127.5;
  }
  return chw;
}

function l2Normalize(data: Float32Array): number[] {
  let sum = 0;
  for (const v of data) sum += v * v;
  const norm = Math.sqrt(sum);
  if (!Number.isFinite(norm) || norm === 0) throw new Error('degenerate face embedding');
  const out = new Array<number>(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i]! / norm;
  return out;
}

/**
 * Detect and embed every face in a batch of image files. Serial per image
 * and per face — bounded transient memory, same discipline as runImageEmbed.
 */
export async function runFaceDetect(
  jobs: Array<{ path: string; hash: string }>,
  models: FaceModelPaths,
): Promise<FaceDetectOutcome[]> {
  if (jobs.length === 0) return [];
  const ort = await loadOrt();
  const detector = await loadSession(models.detector);
  const embedder = await loadSession(models.embedder);
  const out: FaceDetectOutcome[] = [];
  for (const job of jobs) {
    try {
      const buf = await readBoundedImageFile(job.path);
      const rgb = rgbaToRgb(decodeImage(buf));
      const { chw, scale } = yunetInput(rgb);
      const detOut = await detector.run({
        [detector.inputNames[0] ?? 'input']: new ort.Tensor('float32', chw, [
          1,
          3,
          YUNET_INPUT,
          YUNET_INPUT,
        ]),
      });
      const rawOutputs: YunetOutputs = {};
      for (const [name, tensor] of Object.entries(detOut)) rawOutputs[name] = tensor.data;
      const detections = postprocessYunet(rawOutputs);

      const faces: DetectedFaceResult[] = [];
      for (const det of detections) {
        // Back to source coordinates.
        const region = {
          x: Math.max(0, Math.round(det.x / scale)),
          y: Math.max(0, Math.round(det.y / scale)),
          w: Math.min(rgb.width, Math.round(det.w / scale)),
          h: Math.min(rgb.height, Math.round(det.h / scale)),
        };
        const landmarks = det.landmarks.map((v) => v / scale);
        const crop = alignToArcFace(rgb, landmarks);
        const embOut = await embedder.run({
          [embedder.inputNames[0] ?? 'data']: new ort.Tensor('float32', arcfaceInput(crop), [
            1,
            3,
            ARCFACE_SIZE,
            ARCFACE_SIZE,
          ]),
        });
        const first = Object.values(embOut)[0];
        if (!first) throw new Error('face embedder returned no output');
        faces.push({
          faceIndex: faces.length,
          region,
          score: det.score,
          quality: det.score * Math.min(1, Math.min(region.w, region.h) / (2 * FACE_MIN_PX)),
          vector: l2Normalize(first.data),
        });
      }
      out.push({ hash: job.hash, faces });
    } catch (err) {
      if (err instanceof ImageDecodeError) {
        out.push({ hash: job.hash, skip: err.reason, detail: err.message });
      } else {
        out.push({ hash: job.hash, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  return out;
}
