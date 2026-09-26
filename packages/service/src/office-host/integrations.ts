import { createLogger } from '@bendyline/gezel';
import { officeHostPortForHome } from '../http/local-bridge-port.js';
import {
  type LibreOfficeSetupManager,
  createLibreOfficeSetupManager,
} from '../libreoffice-setup/manager.js';
import { type OfficeSetupManager, createOfficeSetupManager } from '../office-setup/manager.js';
import type { StartServiceOptions } from '../service-options.js';
import { resolveLibreOfficeOxt, resolveOfficeDir } from './assets.js';
import { type Fetch, createOfficeHostListener } from './listener.js';

const log = createLogger('office-host');

/**
 * The daemon's half of the Word / Excel / PowerPoint add-ins and the
 * LibreOffice extension, wired as one unit. Office gets the full product app
 * on a stable HTTPS port with the per-user Office certificate; LibreOffice
 * needs no listener, because its extension discovers the daemon like the CLI.
 */
export interface OfficeIntegrations {
  officeSetup: OfficeSetupManager;
  libreofficeSetup: LibreOfficeSetupManager;
  /** Fields the HTTP context carries for the setup routes, `/office`, and consent. */
  contextFields(): {
    officeSetup: OfficeSetupManager;
    libreofficeSetup: LibreOfficeSetupManager;
    officeDir?: string;
    officeHostOrigin: () => string | null;
  };
  /** Hand the listener the product app once it exists; the listener starts later. */
  bindFetch(fetch: Fetch): void;
  /** Boot: restart the Office listener when it was configured. Never throws. */
  reconcile(): Promise<void>;
  stop(): Promise<void>;
}

export function createOfficeIntegrations(
  home: string,
  opts: Pick<StartServiceOptions, 'officeDir' | 'uiDir' | 'officeHostPort'>,
): OfficeIntegrations {
  const officeDir = resolveOfficeDir({ officeDir: opts.officeDir, uiDir: opts.uiDir });
  let appFetch: Fetch | undefined;
  const listener = createOfficeHostListener({
    fetch: () => {
      if (!appFetch) throw new Error('Office host cannot start before the HTTP app is ready');
      return appFetch;
    },
    port: opts.officeHostPort ?? officeHostPortForHome(home),
  });
  const officeSetup = createOfficeSetupManager({
    home,
    listener,
    paneAvailable: () => officeDir !== undefined,
  });
  const oxtPath = resolveLibreOfficeOxt({ uiDir: opts.uiDir });
  const libreofficeSetup = createLibreOfficeSetupManager({
    home,
    oxtPath: () => oxtPath,
  });

  return {
    officeSetup,
    libreofficeSetup,
    contextFields: () => ({
      officeSetup,
      libreofficeSetup,
      ...(officeDir ? { officeDir } : {}),
      officeHostOrigin: () => listener.origin(),
    }),
    bindFetch(fetch) {
      appFetch = fetch;
    },
    async reconcile() {
      await officeSetup.reconcile().catch((err) => {
        log.warn(`Office host not started: ${err instanceof Error ? err.message : err}`);
      });
    },
    stop: () => officeSetup.stop(),
  };
}
