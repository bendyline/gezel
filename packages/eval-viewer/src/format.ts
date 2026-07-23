import type { RunsIndex, Trial } from './types.js';

export function findTrial(runs: RunsIndex, trialId: string): Trial | undefined {
  return runs.trials.find((trial) => trial.trialId === trialId);
}

export function formatDuration(ms: number | null): string {
  if (ms == null) return '—';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function bandColor(band: string | null): string {
  if (band === 'ship-ready') return 'var(--band-ship)';
  if (band === 'needs-tuning' || band === 'capability-bound') return 'var(--band-cap)';
  if (band === 'framework-gap' || band === 'systemic-issue') return 'var(--band-sys)';
  return 'var(--band-none)';
}

const palette = ['#4f8cff', '#ff7a59', '#39c98c', '#c084fc', '#f4b400', '#ec4899'];

export function modelColor(modelId: string | null): string {
  if (!modelId) return '#888';
  let hash = 0;
  for (let i = 0; i < modelId.length; i++) {
    hash = (hash * 31 + modelId.charCodeAt(i)) >>> 0;
  }
  return palette[hash % palette.length] ?? '#888';
}
