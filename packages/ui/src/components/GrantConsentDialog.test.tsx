import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api.js', () => ({
  api: {
    getBaseUrl: () => 'http://127.0.0.1:43935',
    authHeader: () => ({ Authorization: 'Bearer desktop-token' }),
  },
}));

const { GrantConsentDialog } = await import('./GrantConsentDialog.js');

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GrantConsentDialog', () => {
  it('warns clearly about the authority of a CLI grant', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          apps: [],
          grants: [
            {
              id: 'grant-cli',
              appId: 'gezel-cli',
              appName: 'Gezel CLI',
              scopes: ['cli'],
              status: 'pending',
              createdAt: Date.now(),
            },
          ],
        }),
      }),
    );

    render(<GrantConsentDialog />);
    expect(await screen.findByText('Gezel CLI wants to connect')).toBeInTheDocument();
    expect(
      screen.getByText(/CLI access can read and change your gezels, projects, settings, models/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Approve only if you started this request/)).toBeInTheDocument();
  });
});
