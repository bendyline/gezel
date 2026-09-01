/**
 * Renderer-visible lifecycle for a whole-app update.
 *
 * Keep this deliberately small and serializable: values cross Electron IPC
 * and are cached by the renderer while views mount and unmount.
 */
export type UpdateState =
  | { kind: 'checking' }
  | { kind: 'up-to-date'; version: string }
  | { kind: 'available'; version: string }
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

export interface AppUpdateDeliveryPolicy {
  /** Whether electron-updater may be constructed on this platform. */
  initializeElectronUpdater: boolean;
  /** Whether electron-updater may download a package after discovering it. */
  autoDownload: boolean;
  /** Whether a downloaded package may be installed during ordinary app quit. */
  autoInstallOnAppQuit: boolean;
  installation: 'manual' | 'electron-updater' | 'verified-package';
}

/**
 * Whole-app update authority by platform.
 *
 * Linux packages are not yet signed through APT/RPM's distribution trust
 * paths. Keep Linux discovery-only: no electron-updater instance means its
 * elevating DEB/RPM installers cannot be reached accidentally. Unknown
 * platforms inherit the same fail-closed manual posture.
 */
export function appUpdateDeliveryPolicy(platform: string): AppUpdateDeliveryPolicy {
  if (platform === 'darwin') {
    return {
      initializeElectronUpdater: true,
      autoDownload: false,
      autoInstallOnAppQuit: false,
      installation: 'verified-package',
    };
  }
  if (platform === 'win32') {
    return {
      initializeElectronUpdater: true,
      autoDownload: true,
      autoInstallOnAppQuit: true,
      installation: 'electron-updater',
    };
  }
  return {
    initializeElectronUpdater: false,
    autoDownload: false,
    autoInstallOnAppQuit: false,
    installation: 'manual',
  };
}

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
