import { describe, expect, it } from 'vitest';
import {
  appUpdateDeliveryPolicy,
  downloadingUpdateState,
  shouldPublishDownloadState,
  updateErrorStage,
} from './update-state.js';

describe('updater renderer state', () => {
  it('keeps Linux notification-only and denies every automatic delivery path', () => {
    expect(appUpdateDeliveryPolicy('linux')).toEqual({
      initializeElectronUpdater: false,
      autoDownload: false,
      autoInstallOnAppQuit: false,
      installation: 'manual',
    });
  });

  it('preserves the signed Windows and verified macOS delivery paths', () => {
    expect(appUpdateDeliveryPolicy('win32')).toMatchObject({
      initializeElectronUpdater: true,
      autoDownload: true,
      autoInstallOnAppQuit: true,
      installation: 'electron-updater',
    });
    expect(appUpdateDeliveryPolicy('darwin')).toMatchObject({
      initializeElectronUpdater: true,
      autoDownload: false,
      autoInstallOnAppQuit: false,
      installation: 'verified-package',
    });
  });

  it('fails closed on an unsupported platform', () => {
    expect(appUpdateDeliveryPolicy('freebsd')).toEqual(appUpdateDeliveryPolicy('linux'));
  });

  it('rounds and clamps download progress into a compact IPC snapshot', () => {
    expect(
      downloadingUpdateState('1.2.3', {
        percent: 42.6,
        transferred: 12.2,
        total: 30.8,
        bytesPerSecond: 4.4,
      }),
    ).toEqual({
      kind: 'downloading',
      version: '1.2.3',
      percent: 43,
      transferred: 12,
      total: 31,
      bytesPerSecond: 4,
    });
    expect(downloadingUpdateState('1.2.3', { percent: 120 }).percent).toBe(100);
  });

  it('publishes at most once per rounded percentage', () => {
    const previous = downloadingUpdateState('1.2.3', { percent: 42.1 });
    expect(
      shouldPublishDownloadState(previous, downloadingUpdateState('1.2.3', { percent: 42.4 })),
    ).toBe(false);
    expect(
      shouldPublishDownloadState(previous, downloadingUpdateState('1.2.3', { percent: 43.1 })),
    ).toBe(true);
  });

  it('attributes errors to the phase they interrupted', () => {
    expect(updateErrorStage({ kind: 'checking' })).toBe('check');
    expect(updateErrorStage({ kind: 'downloading', version: '1.2.3' })).toBe('download');
    expect(updateErrorStage({ kind: 'ready', version: '1.2.3' })).toBe('install');
  });
});
