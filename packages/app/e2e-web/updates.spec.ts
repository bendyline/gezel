/**
 * Whole-app updater visibility. The browser gallery normally has no Electron
 * preload bridge, so this spec supplies the same tiny update contract before
 * the SPA loads and exercises the renderer exactly as the desktop shell does.
 */
import { expect, test } from './fixtures/test.js';
import { settle } from './helpers/determinism.js';
import { gotoHome, openAreaView } from './helpers/nav.js';
import { shot } from './helpers/shot.js';

test.describe('desktop updates', () => {
  test('download progress and ready-to-install handoff', async ({ page }) => {
    await page.addInitScript(() => {
      type State =
        | {
            kind: 'downloading';
            version: string;
            percent: number;
            transferred: number;
            total: number;
            bytesPerSecond: number;
          }
        | { kind: 'ready'; version: string };
      let current: State = {
        kind: 'downloading',
        version: '1.26224.48',
        percent: 64,
        transferred: 64 * 1024 * 1024,
        total: 100 * 1024 * 1024,
        bytesPerSecond: 8 * 1024 * 1024,
      };
      let listener: ((state: State) => void) | null = null;
      const host = window as unknown as {
        __GEZEL__?: Record<string, unknown>;
        __emitGezelUpdate?: (state: State) => void;
      };
      host.__GEZEL__ = {
        ...(host.__GEZEL__ ?? {}),
        platform: 'win32',
        update: {
          state: async () => current,
          install: async () => ({ ok: true }),
          onStateChanged: (callback: (state: State) => void) => {
            listener = callback;
          },
        },
      };
      host.__emitGezelUpdate = (state) => {
        current = state;
        listener?.(state);
      };
    });

    await gotoHome(page);
    const downloading = page.getByTestId('sidebar-notice-update-downloading');
    await expect(downloading).toContainText('Downloading update · 64%');
    await shot(page, 'downloading', {
      area: 'updates',
      description: 'Windows app update downloading with live progress in the lower navigation rail',
    });

    await page.evaluate(() => {
      const host = window as unknown as {
        __emitGezelUpdate?: (state: { kind: 'ready'; version: string }) => void;
      };
      host.__emitGezelUpdate?.({ kind: 'ready', version: '1.26224.48' });
    });
    await settle(page);

    await expect(page.getByTestId('sidebar-notice-update-ready')).toContainText(
      'Update ready — quit to install',
    );
    await expect(page.getByTestId('update-banner')).toContainText(
      'install automatically after you quit Gezel completely',
    );
    await shot(page, 'ready-home', {
      area: 'updates',
      description: 'Windows update ready: persistent rail notice and actionable Home banner',
    });

    await openAreaView(page, 'settings');
    await page.getByTestId('settings-nav-about').click();
    await expect(page.getByTestId('update-status-ready')).toContainText(
      'Closing the window may leave Gezel running in the system tray',
    );
    await shot(page, 'ready-settings', {
      area: 'updates',
      clip: page.getByTestId('settings-section-about'),
      selector: '[data-testid=settings-section-about]',
      description: 'Settings About explains install-on-quit and offers Install and restart',
    });
  });
});
