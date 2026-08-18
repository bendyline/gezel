import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';
import { primitivesMock } from '../test-utils/primitivesMock.js';

vi.mock('../primitives/index.js', () => primitivesMock);
vi.mock('../api.js', () => ({ api: createMockApi({ storageSummary: vi.fn() }) }));

const { api } = await import('../api.js');

const { MacUninstallDialog, requestMacUninstall } = await import('./MacUninstallDialog.js');

const originalShell = window.__GEZEL__;

const EMPTY_STORAGE = {
  home: '/home/someone/.gezel',
  measuredAt: '2026-08-16T12:00:00.000Z',
  redownloadableBytes: 0,
  userContentBytes: 0,
  categories: [],
};

beforeEach(() => {
  vi.mocked(api.storageSummary).mockResolvedValue(EMPTY_STORAGE);
});

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

describe('MacUninstallDialog — what uninstalling would strand', () => {
  it('names the space that survives an uninstall, and offers to deal with it', async () => {
    // The whole reason this note exists: the uninstaller does not reclaim
    // any of this, and on Windows and Linux it never touches the folder.
    vi.mocked(api.storageSummary).mockResolvedValue({
      home: '/home/someone/.gezel',
      measuredAt: '2026-08-16T12:00:00.000Z',
      redownloadableBytes: 1024 ** 3 * 60,
      userContentBytes: 1024 ** 2 * 40,
      categories: [],
    });
    installMacShell();
    render(<MacUninstallDialog />);
    act(() => requestMacUninstall());

    expect(await screen.findByText('60.0 GB')).toBeInTheDocument();
    expect(screen.getByText('40 MB')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Free up space first/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Back up my content first/ })).toBeInTheDocument();
  });

  it('hands off to the cleanup dialog with downloads pre-selected', async () => {
    vi.mocked(api.storageSummary).mockResolvedValue({
      home: '/home/someone/.gezel',
      measuredAt: '2026-08-16T12:00:00.000Z',
      redownloadableBytes: 1024 ** 3 * 60,
      userContentBytes: 0,
      categories: [],
    });
    const listener = vi.fn();
    window.addEventListener('gezel:show-storage-cleanup', listener);
    installMacShell();
    render(<MacUninstallDialog />);
    act(() => requestMacUninstall());

    fireEvent.click(await screen.findByRole('button', { name: /Free up space first/ }));

    expect(listener).toHaveBeenCalled();
    const event = listener.mock.calls[0]?.[0] as CustomEvent;
    expect(event.detail).toEqual({ preselectRedownloadable: true });
    window.removeEventListener('gezel:show-storage-cleanup', listener);
  });

  it('says nothing when there is nothing stored to worry about', async () => {
    vi.mocked(api.storageSummary).mockResolvedValue({
      home: '/home/someone/.gezel',
      measuredAt: '2026-08-16T12:00:00.000Z',
      redownloadableBytes: 0,
      userContentBytes: 0,
      categories: [],
    });
    installMacShell();
    render(<MacUninstallDialog />);
    act(() => requestMacUninstall());

    await screen.findByRole('button', { name: 'Uninstall Gezel' });
    expect(screen.queryByRole('button', { name: /Free up space first/ })).toBeNull();
  });

  it('still lets the uninstall proceed when the daemon is already gone', async () => {
    // A person uninstalling a broken install must not be blocked by a
    // storage figure we cannot fetch.
    vi.mocked(api.storageSummary).mockRejectedValue(new Error('service is unavailable'));
    const { start } = installMacShell();
    render(<MacUninstallDialog />);
    act(() => requestMacUninstall());

    fireEvent.click(await screen.findByRole('button', { name: 'Uninstall Gezel' }));
    await waitFor(() => expect(start).toHaveBeenCalled());
  });
});
