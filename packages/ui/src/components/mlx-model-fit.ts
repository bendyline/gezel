import { type ChatModelManifest, estimateMlxResidentBytes } from '@bendyline/gezel';

type MlxSizing = Pick<NonNullable<ChatModelManifest['mlx']>, 'approxSizeBytes' | 'residentBytes'>;

/**
 * Prefer the catalog's measured/estimated working set over download size.
 * Download bytes alone do not account for the live model and inference buffers.
 */
export function mlxResidentBytes(mlx: MlxSizing): number {
  // This must stay byte-identical to CapacityBroker. A stale 1.30x UI-only
  // multiplier used to reject Qwen3.8 Flash Next's 112 GB MLX conversion on
  // a 128 GiB Mac even though the measured daemon formula admits it.
  return mlx.residentBytes ?? estimateMlxResidentBytes(mlx.approxSizeBytes);
}

export function mlxFitsMemoryBudget(mlx: MlxSizing, usableBytes: number): boolean {
  return mlxResidentBytes(mlx) <= usableBytes;
}
