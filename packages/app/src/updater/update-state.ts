/**
 * Renderer-visible lifecycle for a whole-app update.
 *
 * Keep this deliberately small and serializable: values cross Electron IPC
 * and are cached by the renderer while views mount and unmount.
 */
export type UpdateState =
  | { kind: 'checking' }
  | { kind: 'up-to-date'; version: string }
  | {
      kind: 'downloading';
      version: string;
      percent?: number;
      transferred?: number;
      total?: number;
      bytesPerSecond?: number;
    }
  | { kind: 'ready'; version: string }
  | {
      kind: 'error';
      stage: 'check' | 'download' | 'install';
      version?: string;
      message: string;
    };

export interface UpdaterDownloadProgress {
  percent?: number;
  transferred?: number;
  total?: number;
  bytesPerSecond?: number;
}

function finiteNonNegative(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

/** Clamp and round the updater's noisy byte-level progress for renderer IPC. */
export function downloadingUpdateState(
  version: string,
  progress: UpdaterDownloadProgress = {},
): Extract<UpdateState, { kind: 'downloading' }> {
  const rawPercent = finiteNonNegative(progress.percent);
  const percent = rawPercent === undefined ? undefined : Math.min(100, rawPercent);
  const transferred = finiteNonNegative(progress.transferred);
  const total = finiteNonNegative(progress.total);
  const bytesPerSecond = finiteNonNegative(progress.bytesPerSecond);

  return {
    kind: 'downloading',
    version,
    ...(percent === undefined ? {} : { percent }),
    ...(transferred === undefined ? {} : { transferred }),
    ...(total === undefined ? {} : { total }),
    ...(bytesPerSecond === undefined ? {} : { bytesPerSecond }),
  };
}

/**
 * electron-updater emits progress for every chunk. The UI only needs a new
 * snapshot when the rounded percentage changes, avoiding hundreds of IPC and
 * React updates during a large NSIS/package download.
 */
export function shouldPublishDownloadState(
  previous: UpdateState | null,
  next: Extract<UpdateState, { kind: 'downloading' }>,
): boolean {
  return (
    previous?.kind !== 'downloading' ||
    previous.version !== next.version ||
    previous.percent !== next.percent
  );
}

/** Attribute a generic updater error to the lifecycle phase it interrupted. */
export function updateErrorStage(state: UpdateState | null): 'check' | 'download' | 'install' {
  if (state?.kind === 'downloading') return 'download';
  if (state?.kind === 'ready') return 'install';
  return 'check';
}
