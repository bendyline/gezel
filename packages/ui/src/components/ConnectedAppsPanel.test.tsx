import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api.js', () => ({
  api: {
    getBaseUrl: () => 'http://127.0.0.1:3333',
    authHeader: () => ({ Authorization: 'Bearer test-token' }),
  },
}));

vi.mock('./ConfirmDialog.js', () => ({ ConfirmDialog: () => null }));

const { ConnectedAppsPanel } = await import('./ConnectedAppsPanel.js');

describe('ConnectedAppsPanel', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          apps: [
            {
              appId: 'desktop-client',
              appName: 'Gezel Desktop',
              scopes: ['ui', 'openai'],
              createdAt: Date.now() - 14 * 60_000,
              lastUsedAt: Date.now(),
            },
            {
              appId: 'vscode',
              appName: 'Visual Studio Code',
              scopes: ['openai'],
              createdAt: Date.now(),
              lastUsedAt: Date.now(),
            },
          ],
          grants: [],
        }),
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders connected apps as one row per app with distinct permission columns', async () => {
    render(<ConnectedAppsPanel />);

    const table = await screen.findByRole('table', { name: 'Connected apps' });
    expect(within(table).getAllByRole('columnheader')).toHaveLength(4);
    expect(within(table).getAllByRole('row')).toHaveLength(3);

    const desktopRow = within(table).getByText('Gezel Desktop').closest('tr');
    expect(desktopRow).not.toBeNull();
    expect(within(desktopRow!).getByText('desktop-client')).toBeInTheDocument();
    expect(within(desktopRow!).getByText('ui')).toBeInTheDocument();
    expect(within(desktopRow!).getByText('openai')).toBeInTheDocument();
    expect(within(desktopRow!).getByLabelText('Revoke Gezel Desktop')).toBeInTheDocument();
  });
});
