/**
 * What core charges for one clip of a catalog video model, as the daemon
 * would admit it: the bench records it beside each measured peak, and the
 * fitter reprices old runs with the current coefficients.
 */
import {
  type MediaBackend,
  type MediaMemoryPool,
  type MediaWeightFile,
  type VideoModelManifest,
  type VideoRenderSize,
  sdCppVideoModelRequirement,
  videoDefaultSize,
  videoMemoryRequirement,
  weightFileFormat,
} from '@bendyline/gezel';

export interface ClipEstimate {
  bytes: number;
  weightBytes: number;
  calibration?: string;
  peakPhase?: string;
}

/** The catalog's files as the estimator prices them: sd.cpp by slot, diffusers by folder. */
export function manifestWeightFiles(manifest: VideoModelManifest): MediaWeightFile[] {
  return manifest.source.files.flatMap((file) => {
    if (!file) return [];
    const format = weightFileFormat(file.name);
    if (!format) return [];
    const slash = file.name.indexOf('/');
    const component = file.role ?? (slash < 0 ? '' : file.name.slice(0, slash));
    return [
      {
        component,
        sizeBytes: file.sizeBytes,
        format,
        ...(file.tensors ? { tensors: file.tensors } : {}),
      },
    ];
  });
}

/** Where the daemon runs this model's engine, as it reported it. */
export interface Placement {
  backend: MediaBackend;
  pool: MediaMemoryPool;
}

/** Core's price for one clip, the same function the daemon admits renders with. */
export function estimateClip(
  manifest: VideoModelManifest,
  size: VideoRenderSize,
  where: Placement,
  animatesPicture = false,
): ClipEstimate {
  const files = manifestWeightFiles(manifest);
  const req =
    manifest.engine === 'sd-cpp'
      ? sdCppVideoModelRequirement({
          files,
          model: manifest,
          pool: where.pool,
          backend: where.backend,
          size,
          animatesPicture,
        })
      : videoMemoryRequirement({
          files,
          family: manifest.family,
          architecture: manifest.architecture,
          accelerator: where.backend === 'cuda' ? 'cuda' : where.backend === 'cpu' ? 'cpu' : 'mps',
          pool: where.pool,
          size,
          defaultSize: videoDefaultSize(manifest),
          guidanceScale: manifest.guidanceScale,
          vaeDtype: manifest.load?.vaeDtype,
        });
  return {
    bytes: req.bytes,
    weightBytes: req.weightBytes,
    ...(req.calibration ? { calibration: req.calibration } : {}),
    ...(req.breakdown ? { peakPhase: req.breakdown.peakPhase } : {}),
  };
}
