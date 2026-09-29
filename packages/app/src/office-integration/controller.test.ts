import type {
  LibreOfficeSetupStatusResponse,
  OfficeHostReport,
  OfficeSetupStatusResponse,
} from '@bendyline/gezel';
import { describe, expect, it, vi } from 'vitest';
import {
  disableLibreOffice,
  disableOffice,
  enableLibreOffice,
  enableOffice,
  verifyLibreOffice,
  verifyOffice,
} from './controller.js';

function officeStatus(
  overrides: Partial<OfficeSetupStatusResponse> = {},
): OfficeSetupStatusResponse {
  return {
    state: 'update-needed',
    reasons: [],
    hostSupported: true,
    officeInstalled: true,
    apps: [
      {
        app: 'word',
        label: 'Word',
        detected: true,
        selected: true,
        manifestId: 'id-w',
        manifestPath: '/m/w.xml',
        registered: null,
      },
      {
        app: 'excel',
        label: 'Excel',
        detected: true,
        selected: false,
        manifestId: 'id-x',
        registered: null,
      },
      {
        app: 'powerpoint',
        label: 'PowerPoint',
        detected: false,
        selected: false,
        manifestId: 'id-p',
        registered: null,
      },
    ],
    listener: { state: 'listening', port: 30000, origin: 'https://localhost:30000' },
    trust: {
      caPem: 'CA',
      caSha1: 'ab'.repeat(20),
      caSha256: 'cd'.repeat(32),
      caCommonName: 'Gezel Office Local CA (x)',
      leafPem: 'LEAF',
      installed: null,
    },
    canConfigure: true,
    canRemove: true,
    ...overrides,
  };
}

function fakeClient(status: OfficeSetupStatusResponse) {
  const reports: OfficeHostReport[] = [];
  const client = {
    getOfficeSetupStatus: vi.fn(async () => status),
    configureOffice: vi.fn(async () => status),
    reportOfficeHost: vi.fn(async (r: OfficeHostReport) => {
      reports.push(r);
      return status;
    }),
    removeOfficeSetup: vi.fn(async () => ({ ...status, state: 'not-configured' as const })),
    getLibreOfficeSetupStatus: vi.fn(),
    configureLibreOffice: vi.fn(),
    reportLibreOfficeHost: vi.fn(),
    removeLibreOfficeSetup: vi.fn(),
  };
  return { client, reports };
}

describe('enableOffice', () => {
  it('trusts the CA, registers chosen apps, unregisters the rest, and reports', async () => {
    const { client, reports } = fakeClient(officeStatus());
    let trusted = false;
    const trust = {
      isTrusted: vi.fn(async () => trusted),
      installTrust: vi.fn(async () => {
        trusted = true;
      }),
    };
    const office = {
      registerOfficeAddin: vi.fn(async () => {}),
      isOfficeAddinRegistered: vi.fn(async () => true),
      unregisterOfficeAddin: vi.fn(async (_reg: { app: string; manifestId: string }) => {}),
    };
    await enableOffice(client as never, ['word'], { trust, office });
    expect(client.configureOffice).toHaveBeenCalledWith({ apps: ['word'] });
    expect(trust.installTrust).toHaveBeenCalledTimes(1);
    expect(office.registerOfficeAddin).toHaveBeenCalledWith({
      app: 'word',
      manifestId: 'id-w',
      manifestPath: '/m/w.xml',
    });
    expect(office.unregisterOfficeAddin.mock.calls.map((c) => c[0])).toEqual([
      { app: 'excel', manifestId: 'id-x' },
      { app: 'powerpoint', manifestId: 'id-p' },
    ]);
    expect(reports[0]).toEqual({
      trust: { installed: true },
      apps: { word: { registered: true } },
    });
  });

  it('does not reinstall a CA that is already trusted', async () => {
    const { client } = fakeClient(officeStatus());
    const trust = { isTrusted: vi.fn(async () => true), installTrust: vi.fn() };
    const office = {
      registerOfficeAddin: vi.fn(async () => {}),
      isOfficeAddinRegistered: vi.fn(async () => true),
      unregisterOfficeAddin: vi.fn(async () => {}),
    };
    await enableOffice(client as never, ['word'], { trust, office });
    expect(trust.installTrust).not.toHaveBeenCalled();
  });

  it('reports each failure instead of stopping at the first', async () => {
    const { client, reports } = fakeClient(officeStatus());
    const trust = {
      isTrusted: vi.fn(async () => false),
      installTrust: vi.fn(async () => {
        throw new Error('The authorization was cancelled by the user.');
      }),
    };
    const office = {
      registerOfficeAddin: vi.fn(async () => {
        throw new Error('Open Word once, then try again.');
      }),
      isOfficeAddinRegistered: vi.fn(async () => false),
      unregisterOfficeAddin: vi.fn(async () => {}),
    };
    await enableOffice(client as never, ['word'], { trust, office });
    expect(reports[0]).toEqual({
      trust: { installed: false, error: 'The authorization was cancelled by the user.' },
      apps: { word: { registered: false, error: 'Open Word once, then try again.' } },
    });
  });
});

describe('disableOffice', () => {
  it('unregisters every app gezel ever registered, removes the CA, then the setup', async () => {
    const { client } = fakeClient(officeStatus());
    const trust = { uninstallTrust: vi.fn(async () => {}) };
    const office = { unregisterOfficeAddin: vi.fn(async () => {}) };
    const result = await disableOffice(client as never, { trust, office });
    expect(office.unregisterOfficeAddin).toHaveBeenCalledTimes(3);
    expect(trust.uninstallTrust).toHaveBeenCalledWith(
      expect.objectContaining({ sha1Hex: 'ab'.repeat(20) }),
    );
    expect(client.removeOfficeSetup).toHaveBeenCalled();
    expect(result.state).toBe('not-configured');
  });
});

describe('verifyOffice', () => {
  it('reports only what changed and never installs a certificate', async () => {
    const status = officeStatus({
      trust: { ...officeStatus().trust, installed: true },
      apps: officeStatus().apps.map((a) => (a.app === 'word' ? { ...a, registered: true } : a)),
    });
    const { client, reports } = fakeClient(status);
    const trust = { isTrusted: vi.fn(async () => false), installTrust: vi.fn() };
    const office = {
      isOfficeAddinRegistered: vi.fn(async () => true),
      registerOfficeAddin: vi.fn(),
      macManifestCopyPath: vi.fn(() => '/nonexistent/copy.xml'),
    };
    await verifyOffice(client as never, { trust, office, platform: 'win32' });
    expect(trust.installTrust).not.toHaveBeenCalled();
    expect(reports).toEqual([{ trust: { installed: false }, apps: {} }]);
  });

  it('leaves unconfigured setups alone', async () => {
    const { client } = fakeClient(officeStatus({ state: 'not-configured' }));
    await verifyOffice(client as never, {});
    expect(client.reportOfficeHost).not.toHaveBeenCalled();
  });
});

function loStatus(
  overrides: Partial<LibreOfficeSetupStatusResponse> = {},
): LibreOfficeSetupStatusResponse {
  return {
    state: 'update-needed',
    reasons: [],
    libreofficeInstalled: true,
    unopkgPath: '/lo/unopkg',
    oxtPath: '/svc/gezel.oxt',
    oxtSha256: 'aa',
    extensionId: 'com.bendyline.gezel',
    installed: null,
    canConfigure: true,
    canRemove: true,
    ...overrides,
  };
}

function loClient(status: LibreOfficeSetupStatusResponse) {
  return {
    getLibreOfficeSetupStatus: vi.fn(async () => status),
    configureLibreOffice: vi.fn(async () => status),
    reportLibreOfficeHost: vi.fn(async () => status),
    removeLibreOfficeSetup: vi.fn(async () => ({ ...status, state: 'not-configured' as const })),
  };
}

describe('LibreOffice', () => {
  it('installs with unopkg and reports success', async () => {
    const client = loClient(loStatus());
    const lo = {
      installLibreOfficeExtension: vi.fn(async () => {}),
      isLibreOfficeExtensionInstalled: vi.fn(async () => null),
    };
    await enableLibreOffice(client as never, { lo });
    expect(lo.installLibreOfficeExtension).toHaveBeenCalledWith({
      unopkgPath: '/lo/unopkg',
      oxtPath: '/svc/gezel.oxt',
    });
    expect(client.reportLibreOfficeHost).toHaveBeenCalledWith({ installed: true });
  });

  it('reports the unopkg error', async () => {
    const client = loClient(loStatus());
    const lo = {
      installLibreOfficeExtension: vi.fn(async () => {
        throw new Error('Close LibreOffice first, then try again.');
      }),
    };
    await enableLibreOffice(client as never, { lo });
    expect(client.reportLibreOfficeHost).toHaveBeenCalledWith({
      installed: false,
      error: 'Close LibreOffice first, then try again.',
    });
  });

  it('removes the extension, then the setup', async () => {
    const client = loClient(loStatus({ installed: true, state: 'configured' }));
    const lo = { uninstallLibreOfficeExtension: vi.fn(async () => {}) };
    await disableLibreOffice(client as never, { lo });
    expect(lo.uninstallLibreOfficeExtension).toHaveBeenCalledWith({ unopkgPath: '/lo/unopkg' });
    expect(client.removeLibreOfficeSetup).toHaveBeenCalled();
  });

  it('installs a newer bundled extension at launch when LibreOffice is closed', async () => {
    const client = loClient(
      loStatus({
        installed: true,
        reasons: ['A newer Gezel extension for LibreOffice is ready to install.'],
      }),
    );
    const lo = {
      isLibreOfficeExtensionInstalled: vi.fn(async () => true),
      installLibreOfficeExtension: vi.fn(async () => {}),
    };
    await verifyLibreOffice(client as never, { lo });
    expect(lo.installLibreOfficeExtension).toHaveBeenCalled();
    expect(client.reportLibreOfficeHost).toHaveBeenCalledWith({ installed: true });
  });
});
