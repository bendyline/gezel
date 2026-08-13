import type { CatalogItemSummary, ProjectDetail } from '@bendyline/gezel';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));

const { ProjectConnectionsTab } = await import('./ProjectConnectionsTab.js');
const { api } = await import('../api.js');

const PROJECT = { id: 'project-alpha', name: 'Alpha' } as ProjectDetail;

function connectorItem(
  id: string,
  name: string,
  overrides: Record<string, unknown> = {},
): CatalogItemSummary {
  return {
    sourceId: 'bundled',
    kind: 'connector-type',
    manifest: {
      schemaVersion: 1,
      kind: 'connector-type',
      id,
      name,
      description: `${name} searchable mirror`,
      tags: ['connector'],
      maintainer: { name: 'gezel' },
      version: '1.0.0',
      releasedAt: '2026-01-01T00:00:00Z',
      completeness: 'mirror',
      secretShape: { kind: 'api-key', label: 'Token', required: false },
      ...overrides,
    },
  } as unknown as CatalogItemSummary;
}

describe('ProjectConnectionsTab connector picker', () => {
  beforeEach(() => {
    vi.mocked(api.listConnectors).mockReset();
    vi.mocked(api.listConnectorActions).mockReset();
    vi.mocked(api.listConnectorTypes).mockReset();
    vi.mocked(api.bindConnector).mockReset();
    vi.mocked(api.getProject).mockReset();

    vi.mocked(api.listConnectors).mockResolvedValue({ bindings: [] } as never);
    vi.mocked(api.listConnectorActions).mockResolvedValue({ pending: [] } as never);
    vi.mocked(api.listConnectorTypes).mockResolvedValue({
      items: [
        connectorItem('github-issues', 'GitHub Issues', {
          configSchema: {
            type: 'object',
            properties: { repository: { type: 'string', title: 'Repository' } },
            required: ['repository'],
          },
        }),
        connectorItem('mail-gmail', 'Gmail', {
          secretShape: { kind: 'oauth2', label: 'Google account', required: true },
        }),
        connectorItem('mail-imap', 'Email (IMAP)', {
          completeness: 'window',
          secretShape: { kind: 'imap', label: 'Mail login', required: true },
          configSchema: {
            type: 'object',
            properties: { address: { type: 'string', title: 'Email address' } },
            required: ['address'],
          },
        }),
      ],
    } as never);
    vi.mocked(api.bindConnector).mockResolvedValue({} as never);
    vi.mocked(api.getProject).mockResolvedValue(PROJECT);
  });

  it('renders compact selectable tiles and keeps the chosen connector visible', async () => {
    render(<ProjectConnectionsTab project={PROJECT} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Add connection' }));

    const gallery = await screen.findByRole('radiogroup', { name: 'Connector type' });
    expect(gallery).toBeInTheDocument();
    expect(screen.getAllByRole('radio')).toHaveLength(3);
    expect(screen.queryByRole('button', { name: 'Select' })).not.toBeInTheDocument();

    const gmail = screen.getByRole('radio', { name: 'Gmail' });
    const imap = screen.getByRole('radio', { name: 'Email (IMAP)' });
    expect(gmail).toHaveAttribute('aria-checked', 'false');

    await user.click(gmail);
    expect(gmail).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByLabelText('Gmail setup')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect' })).toBeInTheDocument();

    await user.type(screen.getByLabelText(/Display name/), 'Personal mail');
    await user.click(imap);
    expect(gmail).toHaveAttribute('aria-checked', 'false');
    expect(imap).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByLabelText(/Display name/)).toHaveValue('');
    expect(screen.getByLabelText('IMAP host')).toBeInTheDocument();
  });

  it('binds the selected tile with its configured values', async () => {
    render(<ProjectConnectionsTab project={PROJECT} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Add connection' }));
    await user.click(await screen.findByRole('radio', { name: 'GitHub Issues' }));
    await user.type(screen.getByLabelText('Repository'), 'bendyline/gezel');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => {
      expect(api.bindConnector).toHaveBeenCalledWith('project-alpha', {
        type: 'github-issues',
        config: { repository: 'bendyline/gezel' },
      });
    });
  });

  it('preserves JSON-schema boolean defaults and numeric config values', async () => {
    vi.mocked(api.listConnectorTypes).mockResolvedValue({
      items: [
        connectorItem('github-releases', 'GitHub Releases', {
          configSchema: {
            type: 'object',
            properties: {
              maxReleases: {
                type: 'integer',
                title: 'Latest releases',
                minimum: 1,
                maximum: 10_000,
              },
              includeDrafts: { type: 'boolean', title: 'Include drafts', default: true },
            },
          },
        }),
      ],
    } as never);
    render(<ProjectConnectionsTab project={PROJECT} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Add connection' }));
    await user.click(await screen.findByRole('radio', { name: 'GitHub Releases' }));
    expect(screen.getByLabelText('Include drafts')).toBeChecked();
    await user.type(screen.getByLabelText('Latest releases'), '12');
    await user.click(screen.getByLabelText('Include drafts'));
    await user.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => {
      expect(api.bindConnector).toHaveBeenCalledWith('project-alpha', {
        type: 'github-releases',
        config: { maxReleases: 12, includeDrafts: false },
      });
    });
  });
});

describe('ProjectConnectionsTab bring-your-own OAuth app', () => {
  const X_POSTS = connectorItem('x-posts', 'X Posts', {
    completeness: 'window',
    secretShape: {
      kind: 'oauth2',
      label: 'X account',
      required: true,
      clientIdEnv: 'GEZEL_X_CLIENT_ID',
      clientSecretEnv: 'GEZEL_X_CLIENT_SECRET',
      clientSetup: {
        providerLabel: 'X (Twitter)',
        docsUrl: 'https://developer.x.com/en/portal/dashboard',
        secretRequired: false,
        appTypeNote: 'Create a free developer app.',
        redirectPort: 6241,
        redirectNote: 'X matches callback URLs exactly.',
      },
    },
  });
  const INSTAGRAM = connectorItem('instagram-media', 'Instagram Media', {
    completeness: 'window',
    secretShape: {
      kind: 'oauth2',
      label: 'Instagram account',
      required: true,
      clientIdEnv: 'GEZEL_INSTAGRAM_CLIENT_ID',
      clientSecretEnv: 'GEZEL_INSTAGRAM_CLIENT_SECRET',
      clientSetup: { providerLabel: 'Instagram (Meta)', secretRequired: true },
    },
  });

  const mailOAuthListen = vi.fn();
  const mailOAuthAwait = vi.fn();

  beforeEach(() => {
    for (const method of [
      'listConnectors',
      'listConnectorActions',
      'listConnectorTypes',
      'listOAuthClients',
      'putOAuthClient',
      'startConnectorOAuth',
      'completeConnectorOAuth',
      'getProject',
    ] as const) {
      vi.mocked(api[method]).mockReset();
    }
    vi.mocked(api.listConnectors).mockResolvedValue({ bindings: [] } as never);
    vi.mocked(api.listConnectorActions).mockResolvedValue({ pending: [] } as never);
    vi.mocked(api.listConnectorTypes).mockResolvedValue({ items: [X_POSTS, INSTAGRAM] } as never);
    vi.mocked(api.listOAuthClients).mockResolvedValue({ clients: [] } as never);
    vi.mocked(api.putOAuthClient).mockResolvedValue({ ok: true } as never);
    vi.mocked(api.startConnectorOAuth).mockResolvedValue({
      ok: true,
      authUrl: 'https://x.com/i/oauth2/authorize?x=1',
      state: 'st-1',
    } as never);
    vi.mocked(api.completeConnectorOAuth).mockResolvedValue({ ok: true } as never);
    vi.mocked(api.getProject).mockResolvedValue(PROJECT);

    mailOAuthListen.mockReset();
    mailOAuthAwait.mockReset();
    mailOAuthListen.mockResolvedValue({
      requestId: 'req-1',
      redirectUri: 'http://127.0.0.1:6241/callback',
    });
    mailOAuthAwait.mockResolvedValue({ code: 'auth-code', state: 'st-1' });
    window.__GEZEL__ = { token: 'test-token', mailOAuthListen, mailOAuthAwait };
  });

  afterEach(() => {
    Reflect.deleteProperty(window, '__GEZEL__');
  });

  async function selectXPosts() {
    render(<ProjectConnectionsTab project={PROJECT} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Add connection' }));
    await user.click(await screen.findByRole('radio', { name: 'X Posts' }));
    return user;
  }

  it('offers the setup panel proactively, saves the app, then connects on the fixed port', async () => {
    const user = await selectXPosts();

    await user.click(await screen.findByRole('button', { name: 'Use your own X (Twitter) app' }));
    expect(screen.getByText('Create a free developer app.')).toBeInTheDocument();
    expect(screen.getByText('http://127.0.0.1:6241/callback')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /developer console/ })).toHaveAttribute(
      'href',
      'https://developer.x.com/en/portal/dashboard',
    );

    await user.type(screen.getByLabelText('Client ID'), 'my-x-app');
    await user.click(screen.getByRole('button', { name: 'Save & connect' }));

    await waitFor(() => {
      expect(api.putOAuthClient).toHaveBeenCalledWith('GEZEL_X_CLIENT_ID', {
        clientId: 'my-x-app',
      });
    });
    await waitFor(() => {
      expect(mailOAuthListen).toHaveBeenCalledWith({ port: 6241 });
      expect(api.startConnectorOAuth).toHaveBeenCalledWith(
        'project-alpha',
        expect.objectContaining({
          type: 'x-posts',
          redirectUri: 'http://127.0.0.1:6241/callback',
        }),
      );
      expect(api.completeConnectorOAuth).toHaveBeenCalledWith('project-alpha', {
        state: 'st-1',
        code: 'auth-code',
      });
    });
  });

  it('opens the setup form when connecting fails with the not-configured error', async () => {
    vi.mocked(api.startConnectorOAuth).mockRejectedValue(
      new Error(
        "OAuth is not configured for this connector — add your own app's client ID under Settings (Connections), or set GEZEL_X_CLIENT_ID (and GEZEL_X_CLIENT_SECRET).",
      ),
    );
    const user = await selectXPosts();

    expect(screen.queryByLabelText('Client ID')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Connect' }));

    expect(await screen.findByLabelText('Client ID')).toBeInTheDocument();
    expect(screen.getByText(/OAuth is not configured/)).toBeInTheDocument();
  });

  it('shows the registered app as a summary with an Edit affordance', async () => {
    vi.mocked(api.listOAuthClients).mockResolvedValue({
      clients: [{ key: 'GEZEL_X_CLIENT_ID', clientId: 'registered-id-123', hasSecret: true }],
    } as never);
    const user = await selectXPosts();

    expect(await screen.findByText('registered-id-123')).toBeInTheDocument();
    expect(screen.getByText(/secret saved/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByLabelText('Client ID')).toHaveValue('registered-id-123');
  });

  it('requires the client secret when the manifest demands one', async () => {
    render(<ProjectConnectionsTab project={PROJECT} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Add connection' }));
    await user.click(await screen.findByRole('radio', { name: 'Instagram Media' }));

    await user.click(
      await screen.findByRole('button', { name: 'Use your own Instagram (Meta) app' }),
    );
    await user.type(screen.getByLabelText('Client ID'), 'my-meta-app');
    await user.click(screen.getByRole('button', { name: 'Save & connect' }));

    expect(await screen.findByText(/requires a client secret/)).toBeInTheDocument();
    expect(api.putOAuthClient).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText(/Client secret/), 'shh');
    await user.click(screen.getByRole('button', { name: 'Save & connect' }));
    await waitFor(() => {
      expect(api.putOAuthClient).toHaveBeenCalledWith('GEZEL_INSTAGRAM_CLIENT_ID', {
        clientId: 'my-meta-app',
        clientSecret: 'shh',
      });
    });
    // No fixed port declared — the listener falls back to an ephemeral one.
    await waitFor(() => expect(mailOAuthListen).toHaveBeenCalledWith(undefined));
  });
});
