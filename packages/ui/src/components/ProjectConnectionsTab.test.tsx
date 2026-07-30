import type { CatalogItemSummary, ProjectDetail } from '@bendyline/gezel';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
});
