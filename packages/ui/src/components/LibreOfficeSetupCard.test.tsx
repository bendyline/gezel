import type { LibreOfficeSetupStatusResponse } from '@bendyline/gezel';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const getLibreOfficeSetupStatus = vi.fn();
vi.mock('../api.js', () => ({ api: { officeIntegrations: { getLibreOfficeSetupStatus } } }));
vi.mock('./ConfirmDialog.js', () => ({ ConfirmDialog: () => null }));

const { LibreOfficeSetupCard } = await import('./LibreOfficeSetupCard.js');

function status(
  overrides: Partial<LibreOfficeSetupStatusResponse> = {},
): LibreOfficeSetupStatusResponse {
  return {
    state: 'not-configured',
    reasons: [],
    libreofficeInstalled: true,
    unopkgPath: '/lo/unopkg',
    version: '25.8.1.1',
    oxtPath: '/svc/gezel.oxt',
    oxtSha256: 'aa',
    extensionId: 'com.bendyline.gezel',
    installed: null,
    canConfigure: true,
    canRemove: false,
    ...overrides,
  };
}

afterEach(() => {
  if (window.__GEZEL__) {
    delete window.__GEZEL__.libreoffice;
    delete window.__GEZEL__.mode;
  }
});

describe('LibreOfficeSetupCard', () => {
  it('installs through the desktop bridge', async () => {
    const bridge = {
      verify: vi.fn(async () => ({ ok: true as const, status: status() })),
      enable: vi.fn(async () => ({
        ok: true as const,
        status: status({ state: 'configured', installed: true, canRemove: true }),
      })),
      disable: vi.fn(),
    };
    window.__GEZEL__ = {
      ...(window.__GEZEL__ ?? {}),
      mode: 'embedded',
      libreoffice: bridge,
    } as typeof window.__GEZEL__;
    render(<LibreOfficeSetupCard />);
    await screen.findByText('LibreOffice 25.8.1.1 was found.');
    expect(screen.getByText('Close LibreOffice before installing.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Install in LibreOffice' }));
    await waitFor(() => expect(bridge.enable).toHaveBeenCalled());
    await screen.findByText(/Tools > Gezel/);
  });

  it('says so when LibreOffice is missing', async () => {
    getLibreOfficeSetupStatus.mockResolvedValue(
      status({
        state: 'unavailable',
        libreofficeInstalled: false,
        unopkgPath: undefined,
        version: undefined,
        message: 'LibreOffice was not found on this computer.',
        canConfigure: false,
      }),
    );
    render(<LibreOfficeSetupCard />);
    await screen.findByText('LibreOffice was not found on this computer.');
    expect(screen.queryByRole('button', { name: /Install/ })).toBeNull();
  });
});
