/**
 * Pinned face-lane models (lane B of image search) — the recognition-catalog
 * pattern (providers/recognition/catalog.ts): explicit upstream URL at a
 * pinned revision + sha256 per file, downloaded through the shared
 * `downloadWithSha256` into `<home>/engines/face-models/<id>/`.
 *
 * License is a hard requirement here, not a nicety: insightface's own
 * pretrained weights are research-only and are deliberately NOT used. YuNet
 * is MIT (© Shiqi Yu, OpenCV Zoo); AuraFace-v1 is fal.ai's Apache-2.0
 * ArcFace-compatible release, published expressly for commercial use. Only
 * `glintr100.onnx` (the AuraFace recognition model itself) is taken from that
 * repo — the detector it bundles has murkier provenance, which is exactly why
 * YuNet does detection.
 *
 * Downloads run HOST-side (before work is dispatched to the image worker);
 * the worker only ever receives resolved file paths. This keeps the worker's
 * import graph clean for the containment test.
 */

import { existsSync } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from '@bendyline/gezel';
import { downloadWithSha256 } from '../../providers/audio/whisper-cpp.js';

const log = createLogger('face');

export interface FaceModelSpec {
  id: string;
  role: 'detect' | 'embed';
  fileName: string;
  url: string;
  sha256: string;
  approxSizeBytes: number;
  license: string;
  homepage: string;
}

export const FACE_MODEL_CATALOG: FaceModelSpec[] = [
  {
    id: 'yunet-2023mar',
    role: 'detect',
    fileName: 'face_detection_yunet_2023mar.onnx',
    url: 'https://github.com/opencv/opencv_zoo/raw/f12e12798e8314f7c074a6656816c048dcc95b7a/models/face_detection_yunet/face_detection_yunet_2023mar.onnx',
    sha256: '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4',
    approxSizeBytes: 232_589,
    license: 'MIT',
    homepage: 'https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet',
  },
  {
    id: 'auraface-v1',
    role: 'embed',
    fileName: 'glintr100.onnx',
    url: 'https://huggingface.co/fal/AuraFace-v1/resolve/af6d057c9b0ec4071d4c49c80e3539258798b609/glintr100.onnx',
    sha256: 'a7933ea5330113b01c9b60351d8f4c33003f145d8470ac5f0e52ee2effe25c60',
    approxSizeBytes: 260_694_151,
    license: 'Apache-2.0',
    homepage: 'https://huggingface.co/fal/AuraFace-v1',
  },
];

/** Total download the opt-in UI discloses (~261 MB). */
export const FACE_MODELS_TOTAL_BYTES = FACE_MODEL_CATALOG.reduce(
  (sum, m) => sum + m.approxSizeBytes,
  0,
);

export function faceModelsRoot(home: string): string {
  return join(home, 'engines', 'face-models');
}

export function faceModelPath(home: string, spec: FaceModelSpec): string {
  return join(faceModelsRoot(home), spec.id, spec.fileName);
}

export interface FaceModelPaths {
  detector: string;
  embedder: string;
}

/** Resolve model paths when every pinned file is already on disk, else null. */
export function installedFaceModels(home: string): FaceModelPaths | null {
  const detect = FACE_MODEL_CATALOG.find((m) => m.role === 'detect')!;
  const embed = FACE_MODEL_CATALOG.find((m) => m.role === 'embed')!;
  const detector = faceModelPath(home, detect);
  const embedder = faceModelPath(home, embed);
  return existsSync(detector) && existsSync(embedder) ? { detector, embedder } : null;
}

/**
 * Download any missing pinned models (sha256-verified, .partial + rename, so
 * a crash never leaves a half-file behind that `installedFaceModels` would
 * trust). Serialized per process; concurrent callers share one attempt.
 */
let ensureInflight: Promise<FaceModelPaths | null> | null = null;

export function ensureFaceModels(
  home: string,
  fetchImpl: typeof fetch = fetch,
): Promise<FaceModelPaths | null> {
  if (!ensureInflight) {
    ensureInflight = ensureFaceModelsInner(home, fetchImpl).finally(() => {
      ensureInflight = null;
    });
  }
  return ensureInflight;
}

async function ensureFaceModelsInner(
  home: string,
  fetchImpl: typeof fetch,
): Promise<FaceModelPaths | null> {
  const already = installedFaceModels(home);
  if (already) return already;
  let written = 0;
  for (const spec of FACE_MODEL_CATALOG) {
    const dest = faceModelPath(home, spec);
    if (existsSync(dest)) {
      written += await stat(dest).then(
        (s) => s.size,
        () => spec.approxSizeBytes,
      );
      continue;
    }
    await mkdir(join(faceModelsRoot(home), spec.id), { recursive: true });
    log.info(
      `[face] downloading ${spec.id} (${Math.round(spec.approxSizeBytes / 1_000_000)} MB, ${spec.license})`,
    );
    const download = downloadWithSha256(fetchImpl, {
      url: spec.url,
      destPath: dest,
      expectedSha256: spec.sha256,
      approxSizeBytes: spec.approxSizeBytes,
      writtenSoFar: written,
      totalAllBytes: FACE_MODELS_TOTAL_BYTES,
    });
    let result = await download.next();
    while (!result.done) result = await download.next();
    if (result.value.kind === 'error') {
      log.warn(`[face] ${spec.id} download failed: ${result.value.error}`);
      return null;
    }
    written = result.value.writtenAll;
    log.info(`[face] ${spec.id} installed`);
  }
  return installedFaceModels(home);
}
