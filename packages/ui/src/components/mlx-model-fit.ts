import type { ChatModelManifest } from '@bendyline/gezel';

type MlxSizing = Pick<NonNullable<ChatModelManifest['mlx']>, 'approxSizeBytes' | 'residentBytes'>;

/** Matches the native capacity broker's MLX fallback when no measured peak is cataloged. */
export const MLX_FALLBACK_RESIDENT_FACTOR = 1.3;

/**
 * Prefer the catalog's measured/estimated working set over download size.
 * Download bytes alone do not account for the live model and inference buffers.
 */
export function mlxResidentBytes(mlx: MlxSizing): number {
  return mlx.residentBytes ?? Math.round(mlx.approxSizeBytes * MLX_FALLBACK_RESIDENT_FACTOR);
}

export function mlxFitsMemoryBudget(mlx: MlxSizing, usableBytes: number): boolean {
  return mlxResidentBytes(mlx) <= usableBytes;
}
