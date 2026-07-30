import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api.js', () => ({
  api: {
    getBaseUrl: () => 'http://127.0.0.1:6228',
    authHeader: () => ({ Authorization: 'Bearer desktop-token' }),
  },
}));

const { GrantConsentDialog } = await import('./GrantConsentDialog.js');

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GrantConsentDialog', () => {
  it('warns that product apps can read and change Gezel state', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          apps: [],
          grants: [
            {
              id: 'grant-vscode',
              appId: 'vscode',
              appName: 'Visual Studio Code',
              scopes: ['product', 'openai'],
              status: 'pending',
              createdAt: Date.now(),
              verificationRequired: true,
            },
          ],
        }),
      }),
    );

    render(<GrantConsentDialog />);
    expect(await screen.findByText('Visual Studio Code wants to connect')).toBeInTheDocument();
    expect(
      screen.getByText(/Product access can read and change your gezels, projects, settings/),
    ).toBeInTheDocument();
    expect(screen.getByText(/started this request from Visual Studio Code/)).toBeInTheDocument();
    expect(screen.getByLabelText('Connection code')).toBeInTheDocument();
  });

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
              verificationRequired: true,
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
    const input = screen.getByLabelText('Connection code');
    const approve = screen.getByRole('button', { name: 'Approve' });
    expect(input).toHaveValue('');
    expect(screen.queryByText('XA2-M6N')).not.toBeInTheDocument();
    expect(approve).toBeDisabled();

    fireEvent.change(input, { target: { value: 'xa2m6n' } });
    expect(input).toHaveValue('XA2-M6N');
    expect(approve).toBeEnabled();
  });
});
