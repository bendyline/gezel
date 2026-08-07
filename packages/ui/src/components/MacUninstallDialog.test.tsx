import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { primitivesMock } from '../test-utils/primitivesMock.js';

vi.mock('../primitives/index.js', () => primitivesMock);

const { MacUninstallDialog, requestMacUninstall } = await import('./MacUninstallDialog.js');

const originalShell = window.__GEZEL__;

afterEach(() => {
  window.__GEZEL__ = originalShell;
});

function installMacShell(start = vi.fn().mockResolvedValue({ ok: true })) {
  let nativeShow: (() => void) | undefined;
  const removeListener = vi.fn();
  window.__GEZEL__ = {
    token: 'test-token',
    platform: 'darwin',
    uninstall: {
      start,
      onShowRequested: (callback) => {
        nativeShow = callback;
        return removeListener;
      },
    },
  };
  return { start, showFromMenu: () => nativeShow?.(), removeListener };
}

describe('MacUninstallDialog', () => {
  it('keeps every data-removal choice off by default', async () => {
    const { start } = installMacShell();
    render(<MacUninstallDialog />);

    act(() => requestMacUninstall());
    fireEvent.click(screen.getByRole('button', { name: 'Uninstall Gezel' }));

    await waitFor(() => {
      expect(start).toHaveBeenCalledWith({
        removeMachineData: false,
        removeSharedData: false,
        removeCurrentUserData: false,
      });
    });
  });

  it('sends the same explicit choices from the native Help menu handoff', async () => {
    const shell = installMacShell();
    const { unmount } = render(<MacUninstallDialog />);

    act(() => shell.showFromMenu());
    fireEvent.click(screen.getByLabelText(/Downloaded models and machine-engine data/));
    fireEvent.click(screen.getByLabelText(/Machine-shared projects and gezels/));
    fireEvent.click(screen.getByLabelText(/My projects, chats, credentials, and settings/));
    fireEvent.click(screen.getByRole('button', { name: 'Uninstall and delete selected data' }));

    await waitFor(() => {
      expect(shell.start).toHaveBeenCalledWith({
        removeMachineData: true,
        removeSharedData: true,
        removeCurrentUserData: true,
      });
    });

    unmount();
    expect(shell.removeListener).toHaveBeenCalledOnce();
  });

  it('keeps the app open and reports a failed privileged handoff', async () => {
    installMacShell(
      vi.fn().mockResolvedValue({ ok: false, error: 'The signed uninstaller is unavailable.' }),
    );
    render(<MacUninstallDialog />);

    act(() => requestMacUninstall());
    fireEvent.click(screen.getByRole('button', { name: 'Uninstall Gezel' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The signed uninstaller is unavailable.',
    );
    expect(screen.getByRole('button', { name: 'Uninstall Gezel' })).toBeEnabled();
  });
});
