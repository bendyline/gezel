import type { GildeUpdateStatusResponse } from '@bendyline/gezel';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

const status = (over: Partial<GildeUpdateStatusResponse> = {}): GildeUpdateStatusResponse => ({
  enabled: false,
  mode: 'bundled',
  bundledVersion: '0.1.15',
  activeVersion: null,
  lastCheck: null,
  updateInProgress: false,
  ...over,
});

vi.mock('../api.js', () => ({
  api: createMockApi({
    getGildeUpdateStatus: vi.fn().mockResolvedValue({
      enabled: false,
      mode: 'bundled',
      bundledVersion: '0.1.15',
      activeVersion: null,
      lastCheck: null,
      updateInProgress: false,
    }),
    updateConfig: vi.fn().mockResolvedValue({}),
    checkGildeUpdates: vi.fn().mockResolvedValue({ started: true }),
  }),
}));

const { api } = await import('../api.js');
const { GildeUpdatesCard } = await import('./GildeUpdatesCard.js');

describe('GildeUpdatesCard', () => {
  it('hydrates from status and reflects a live content source', async () => {
    vi.mocked(api.getGildeUpdateStatus).mockResolvedValue(
      status({
        enabled: true,
        mode: 'live',
        activeVersion: '0.1.19',
        lastCheck: { at: '2026-08-07T10:00:00Z', outcome: 'updated', version: '0.1.19' },
      }),
    );
    render(<GildeUpdatesCard />);
    const checkbox = await screen.findByRole('checkbox');
    await waitFor(() => expect(checkbox).toBeChecked());
    expect(screen.getByText(/Content: 0\.1\.19 \(app shipped with 0\.1\.15\)/)).toBeTruthy();
    expect(screen.getByText(/updated to 0\.1\.19/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Check now' })).not.toBeDisabled();
  });

  it('saves the toggle and rolls back on failure', async () => {
    vi.mocked(api.getGildeUpdateStatus).mockResolvedValue(status());
    vi.mocked(api.updateConfig).mockRejectedValueOnce(new Error('daemon unreachable'));
    render(<GildeUpdatesCard />);
    const checkbox = await screen.findByRole('checkbox');
    await waitFor(() => expect(checkbox).not.toBeChecked());

    fireEvent.click(checkbox);
    expect(api.updateConfig).toHaveBeenCalledWith({ gildeUpdates: { enabled: true } });
    await waitFor(() => expect(checkbox).not.toBeChecked());
    expect(screen.getByText(/daemon unreachable/)).toBeTruthy();
  });

  it('disables Check now while off or overridden, kicks a check when usable', async () => {
    vi.mocked(api.getGildeUpdateStatus).mockResolvedValue(status({ enabled: false }));
    const { unmount } = render(<GildeUpdatesCard />);
    await screen.findByRole('checkbox');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Check now' })).toBeDisabled());
    unmount();

    vi.mocked(api.getGildeUpdateStatus).mockResolvedValue(
      status({ enabled: true, mode: 'overridden' }),
    );
    const second = render(<GildeUpdatesCard />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Check now' })).toBeDisabled());
    expect(screen.getByText(/developer override/)).toBeTruthy();
    second.unmount();

    vi.mocked(api.getGildeUpdateStatus).mockResolvedValue(status({ enabled: true }));
    render(<GildeUpdatesCard />);
    const button = await screen.findByRole('button', { name: 'Check now' });
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button);
    await waitFor(() => expect(api.checkGildeUpdates).toHaveBeenCalledTimes(1));
    // Optimistically marked in-flight until the next poll lands.
    expect(screen.getByText(/checking…/)).toBeTruthy();
  });
});
