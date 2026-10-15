/**
 * Plain-language labels for the first-run model download: sizes, times, and
 * the friendly name of the recommended model. Pure, so the welcome and its
 * tests share one wording.
 */

import type { LocalActiveInstall } from '@bendyline/gezel-client';

export interface InstallProgress {
  bytesWritten: number;
  totalBytes: number;
  phase: LocalActiveInstall['phase'];
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

/** "3.9 GB", or "680 MB" below a gigabyte. */
export function formatDownloadSize(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

/** What a first-run download averages: Hugging Face to a home connection. */
const FIRST_RUN_GB_PER_MINUTE = 0.6;

/**
 * Rough download time, ceiled to the next 5 minutes. The rate is ~0.6 GB a
 * minute (about 80 Mbps effective), measured on a first run: the old 1 GB a
 * minute promised "about 10 minutes" for what took 24 (2026-10-12). Rounding
 * up because a too-low estimate disappoints more than a too-high one.
 */
export function formatDownloadTime(sizeBytes: number | null): string {
  if (!sizeBytes) return 'a few minutes';
  const gb = sizeBytes / 1024 ** 3;
  const minutes = Math.max(5, Math.ceil(gb / FIRST_RUN_GB_PER_MINUTE / 5) * 5);
  return `about ${minutes} minutes`;
}

export function readSizeFromCatalog(
  detail: { manifest: unknown } | null,
  provider: 'mlx' | 'llama-cpp',
): number | null {
  if (!detail) return null;
  const m = detail.manifest as
    | {
        kind?: string;
        approxSizeBytes?: number;
        mlx?: { approxSizeBytes?: number };
        llamaCpp?: { approxSizeBytes?: number };
      }
    | undefined;
  if (!m || m.kind !== 'chat-model') return null;
  const perSource = provider === 'mlx' ? m.mlx?.approxSizeBytes : m.llamaCpp?.approxSizeBytes;
  return perSource ?? m.approxSizeBytes ?? null;
}

/** Percent downloaded, or null while the size is unknown or a later phase runs. */
export function downloadPercent(progress: InstallProgress | null): number | null {
  if (!progress || progress.phase !== 'downloading' || progress.totalBytes <= 0) return null;
  return Math.min(100, Math.round((progress.bytesWritten / progress.totalBytes) * 100));
}

export function modelDisplay(id: string): string {
  // Friendly labels for the recommended models the first-run picker can
  // pin (any model carrying a `recoScore`). Pre-suffix entries (e.g.
  // `gemma4-e2b-mlx`) no longer come out of `resolveFirstRunTarget`, but a
  // user upgrading from an older install may still have the suffix stamped
  // in `config.defaultModel` — keep the alias so labels stay correct until
  // the next install rewrites the pin. Unknown ids fall back to the raw id.
  switch (id) {
    case 'gemma4-e2b-q4':
    case 'gemma4-e2b':
    case 'gemma4-e2b-mlx':
      return 'Gemma 4 (E2B)';
    case 'gemma4-e4b-q4':
    case 'gemma4-e4b':
    case 'gemma4-e4b-mlx':
      return 'Gemma 4 (E4B)';
    case 'gemma4-12b-q4':
    case 'gemma4-12b-q8':
      return 'Gemma 4 (12B)';
    case 'gemma4-26b-q4':
    case 'gemma4-26b':
    case 'gemma4-26b-mlx':
      return 'Gemma 4 (26B-A4B MoE)';
    case 'gemma4-31b-q4':
      return 'Gemma 4 (31B)';
    case 'qwen3.6-27b-q4':
    case 'qwen3.6-27b-q8':
      return 'Qwen 3.6 (27B)';
    case 'qwen3.6-35b-a3b-q4':
    case 'qwen3.6-35b-a3b-q8':
      return 'Qwen 3.6 (35B-A3B MoE)';
    case 'qwen3.8-27b-iq1-s':
    case 'qwen3.8-27b-q2':
    case 'qwen3.8-27b-q3':
    case 'qwen3.8-27b-q4':
    case 'qwen3.8-27b-q6':
    case 'qwen3.8-27b-q8':
      return 'Qwen 3.8 (27B)';
    default:
      return id;
  }
}
