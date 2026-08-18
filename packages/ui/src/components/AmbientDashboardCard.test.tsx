import type { AmbientDashboardStatusResponse } from '@bendyline/gezel';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

const status: AmbientDashboardStatusResponse = {
  enabled: true,
  running: false,
  lastGeneratedAt: null,
  lastFailedAt: null,
  lastError: null,
  latestFilename: null,
  resolution: 'fhd',
  themeId: 'gezellig',
  themes: [
    {
      id: 'gezellig',
      name: 'Gezellig',
      description: 'Cozy, warm, and inviting with rich orange-tinted dark backgrounds.',
    },
    {
      id: 'standard-dark',
      name: 'Standard Dark',
      description: 'Dark navy background with light text.',
    },
  ],
  displayTarget: null,
};

vi.mock('../api.js', () => ({
  api: createMockApi({
    getAmbientDashboard: vi.fn().mockResolvedValue(status),
    updateConfig: vi.fn().mockResolvedValue({}),
    ambientDashboardLatestUrl: vi.fn(() => 'http://127.0.0.1/ambient/latest.png'),
    authHeader: vi.fn(() => ({ Authorization: 'Bearer test' })),
    getFetch: vi.fn(() => vi.fn().mockResolvedValue({ ok: false })),
  }),
}));

const { api } = await import('../api.js');
const { AmbientDashboardCard } = await import('./AmbientDashboardCard.js');

describe('AmbientDashboardCard theme control', () => {
  beforeAll(() => {
    Object.defineProperties(HTMLElement.prototype, {
      hasPointerCapture: { configurable: true, value: () => false },
      setPointerCapture: { configurable: true, value: () => {} },
      releasePointerCapture: { configurable: true, value: () => {} },
      scrollIntoView: { configurable: true, value: () => {} },
    });
  });

  afterAll(() => {
    delete (HTMLElement.prototype as { hasPointerCapture?: unknown }).hasPointerCapture;
    delete (HTMLElement.prototype as { setPointerCapture?: unknown }).setPointerCapture;
    delete (HTMLElement.prototype as { releasePointerCapture?: unknown }).releasePointerCapture;
    delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  afterEach(() => {
    vi.mocked(api.getAmbientDashboard).mockResolvedValue(status);
  });

  it('shows the Squisq catalog and persists a user selection', async () => {
    const user = userEvent.setup();
    render(<AmbientDashboardCard />);

    const trigger = await screen.findByRole('combobox', { name: 'Dashboard theme' });
    expect(trigger).toHaveTextContent('Gezellig');
    expect(trigger.querySelector('[data-theme-id="gezellig"]')).toBeInTheDocument();
    expect(trigger.querySelectorAll('.ambient-theme-swatch')).toHaveLength(3);
    expect(screen.getByText(/Cozy, warm, and inviting/)).toBeInTheDocument();

    await user.click(trigger);
    const darkOption = await screen.findByRole('option', { name: 'Standard Dark' });
    expect(darkOption.querySelector('[data-theme-id="standard-dark"]')).toBeInTheDocument();
    expect(darkOption.querySelectorAll('.ambient-theme-swatch')).toHaveLength(3);
    expect(darkOption).toHaveTextContent('Dark navy background with light text.');
    await user.click(darkOption);

    await waitFor(() =>
      expect(api.updateConfig).toHaveBeenCalledWith({
        ambientDashboard: { themeId: 'standard-dark' },
      }),
    );
  });

  it('surfaces a failed attempt without hiding the last successful generation', async () => {
    vi.mocked(api.getAmbientDashboard).mockResolvedValue({
      ...status,
      lastGeneratedAt: '2026-08-17T22:53:00.000Z',
      lastFailedAt: '2026-08-17T23:49:00.000Z',
      lastError: 'one-shot timed out after 180000ms',
      latestFilename: 'dashboard-20260817-1552.png',
    });

    render(<AmbientDashboardCard />);

    expect(
      await screen.findByText('Dashboard generation failed: one-shot timed out after 180000ms'),
    ).toBeInTheDocument();
    expect(screen.getByText(/Last generated/)).toBeInTheDocument();
  });
});
