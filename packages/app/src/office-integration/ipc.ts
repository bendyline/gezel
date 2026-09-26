import type { IpcMain } from 'electron';
import {
  type OfficeIntegrationClient,
  clearOfficeCache,
  disableLibreOffice,
  disableOffice,
  enableLibreOffice,
  enableOffice,
  repairOffice,
  verifyLibreOffice,
  verifyOffice,
} from './controller.js';
import type { OfficeApp } from './office-register.js';

/**
 * IPC for Word / Excel / PowerPoint and LibreOffice (Settings -> Connected
 * Apps). The daemon owns certificates, the Office listener, manifests, and
 * the .oxt; these handlers do the per-user OS steps (trust store, Office
 * registration, unopkg) and report each outcome back to the daemon. The
 * renderer supplies only the list of Office apps; every path comes from the
 * daemon's status.
 */

/** Resolves the live connection's client, which rotates with each daemon restart. */
export type OfficeClientSource = () => OfficeIntegrationClient | null;

const OFFICE_APP_IDS = new Set(['word', 'excel', 'powerpoint']);

export function parseOfficeApps(value: unknown): OfficeApp[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 3) return null;
  const apps = value.filter((v): v is OfficeApp => typeof v === 'string' && OFFICE_APP_IDS.has(v));
  return apps.length === value.length ? [...new Set(apps)] : null;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function registerOfficeIntegrationIpc(ipcMain: IpcMain, clientSource: OfficeClientSource) {
  const run = async <T>(fn: (client: OfficeIntegrationClient) => Promise<T>) => {
    const client = clientSource();
    if (!client) return { ok: false as const, error: 'service is unavailable' };
    try {
      return { ok: true as const, status: await fn(client) };
    } catch (err) {
      return { ok: false as const, error: errorText(err) };
    }
  };

  ipcMain.handle('gezel:office-host:verify', () => run((client) => verifyOffice(client)));
  ipcMain.handle('gezel:office-host:enable', (_event, apps: unknown) => {
    const parsed = parseOfficeApps(apps);
    if (!parsed) return { ok: false as const, error: 'Choose Word, Excel, or PowerPoint.' };
    return run((client) => enableOffice(client, parsed));
  });
  ipcMain.handle('gezel:office-host:repair', () => run((client) => repairOffice(client)));
  ipcMain.handle('gezel:office-host:disable', () => run((client) => disableOffice(client)));
  ipcMain.handle('gezel:office-host:clear-cache', async () => {
    try {
      await clearOfficeCache();
      return { ok: true as const };
    } catch (err) {
      return { ok: false as const, error: errorText(err) };
    }
  });
  ipcMain.handle('gezel:libreoffice:verify', () => run((client) => verifyLibreOffice(client)));
  ipcMain.handle('gezel:libreoffice:enable', () => run((client) => enableLibreOffice(client)));
  ipcMain.handle('gezel:libreoffice:disable', () => run((client) => disableLibreOffice(client)));
}

/**
 * After each connection: observe the Office and LibreOffice integrations and
 * report drift (a removed certificate, a manifest copy an upgrade changed, a
 * newer bundled extension). Delayed so it never competes with startup, and
 * never installs a certificate — that only happens from a click.
 */
export function createOfficeVerifyScheduler(
  clientSource: OfficeClientSource,
  delayMs = 15_000,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return () => {
    if (timer) clearTimeout(timer);
    if (process.env.GEZEL_E2E === '1') return;
    timer = setTimeout(() => {
      timer = null;
      const client = clientSource();
      if (!client) return;
      void verifyOffice(client).catch((err) => {
        console.warn('[office] verify failed:', errorText(err));
      });
      void verifyLibreOffice(client).catch((err) => {
        console.warn('[libreoffice] verify failed:', errorText(err));
      });
    }, delayMs);
    timer.unref?.();
  };
}
