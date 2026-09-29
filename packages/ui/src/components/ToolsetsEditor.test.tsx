import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';
import { primitivesMock } from '../test-utils/primitivesMock.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));
vi.mock('../primitives/index.js', () => primitivesMock);
vi.mock('./CatalogBrowser.js', () => ({
  CatalogBrowser: ({
    initialItems,
    action,
  }: {
    initialItems?: Array<{ manifest: { id: string } }>;
    action: (item: unknown) => React.ReactNode;
  }) => (
    <div data-testid="catalog-browser">
      {initialItems?.map((item) => (
        <div key={item.manifest.id}>{action(item)}</div>
      ))}
    </div>
  ),
}));

const { ToolsetsEditor } = await import('./ToolsetsEditor.js');
const { api } = await import('../api.js');
const { COMMUNITY_SECRETS_WARNING } = await import('./catalog-provenance.js');

describe('ToolsetsEditor community tier', () => {
  const walletManifest = {
    schemaVersion: 1,
    kind: 'toolset',
    id: 'someone-wallet',
    name: 'Someone Wallet',
    description: 'Pays for things.',
    tags: [],
    maintainer: { name: 'someone' },
    yankedVersions: [],
    version: '1.0.0',
    releasedAt: '2026-09-01T00:00:00Z',
    runtime: { kind: 'http-mcp', url: 'https://example.invalid/mcp' },
    tools: [],
    config: [{ id: 'API_KEY', label: 'API key', type: 'string', secret: true, required: true }],
  };

  beforeEach(() => {
    vi.mocked(api.listInstalledToolsets).mockResolvedValue({ toolsets: [] });
    vi.mocked(api.listCatalogItems).mockResolvedValue({
      items: [{ sourceId: 'community', kind: 'toolset', manifest: walletManifest }],
    } as never);
    vi.mocked(api.getCatalogItem).mockResolvedValue({
      sourceId: 'community',
      kind: 'toolset',
      manifest: walletManifest,
    } as never);
  });

  it('warns before a community toolset collects keys', async () => {
    render(<ToolsetsEditor scope={{ kind: 'shared' }} subject="everyone" />);
    await waitFor(() => expect(api.listCatalogItems).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: '+ Add toolset' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Install' }));
    expect(await screen.findByText(COMMUNITY_SECRETS_WARNING)).toBeInTheDocument();
  });

  it('captions an installed community toolset as unreviewed', async () => {
    vi.mocked(api.listInstalledToolsets).mockResolvedValue({
      toolsets: [
        {
          toolsetId: 'someone-wallet',
          sourceId: 'community',
          version: '1.0.0',
          installedAt: '2026-09-01T00:00:00.000Z',
          runtime: { kind: 'http-mcp', url: 'https://example.invalid/mcp' },
        },
      ],
    } as never);
    render(<ToolsetsEditor scope={{ kind: 'shared' }} subject="everyone" />);
    expect(await screen.findByText('Community · not reviewed by Gezel')).toBeInTheDocument();
  });
});

describe('ToolsetsEditor custom MCP import', () => {
  beforeEach(() => {
    vi.mocked(api.listInstalledToolsets).mockResolvedValue({ toolsets: [] });
    vi.mocked(api.listCatalogItems).mockResolvedValue({ items: [] });
    vi.mocked(api.importCustomMcpConfig).mockResolvedValue({
      ok: true,
      imported: ['local-tools'],
      warnings: [],
    });
  });

  it('imports pasted MCP JSON into the current project scope', async () => {
    render(
      <ToolsetsEditor scope={{ kind: 'project', projectId: 'project-1' }} subject="Workshop" />,
    );
    await waitFor(() => expect(api.listInstalledToolsets).toHaveBeenCalled());

    expect(screen.getByText('Additional project toolsets')).toBeInTheDocument();
    const addToolsetButton = screen.getByRole('button', { name: '+ Add toolset' });
    expect(addToolsetButton).not.toHaveClass('gz-link-button');
    fireEvent.click(addToolsetButton);
    fireEvent.click(screen.getByRole('tab', { name: 'Custom MCP' }));
    const text = '{"servers":{"local-tools":{"command":"node","args":["server.js"]}}}';
    fireEvent.change(screen.getByLabelText('JSON'), { target: { value: text } });
    fireEvent.click(screen.getByRole('button', { name: 'Import toolsets' }));

    await waitFor(() =>
      expect(api.importCustomMcpConfig).toHaveBeenCalledWith({
        scope: { kind: 'project', projectId: 'project-1' },
        text,
        sourceName: 'Pasted JSON',
      }),
    );
    expect(
      await screen.findByText(/Imported 1 custom MCP server: local-tools/),
    ).toBeInTheDocument();
  });

  it('shows discovered project-file toolsets as locked project configuration', async () => {
    vi.mocked(api.listInstalledToolsets).mockResolvedValue({
      toolsets: [
        {
          toolsetId: 'custom.project',
          sourceId: 'project-mcp',
          version: 'custom',
          installedAt: '2026-07-28T00:00:00.000Z',
          runtime: {
            kind: 'custom-mcp',
            serverName: 'workspace-tools',
            transport: 'stdio',
            source: { kind: 'project-file', relativePath: '.vscode/mcp.json' },
            args: [],
            envKeys: [],
            headerKeys: [],
          },
        },
      ],
    });

    render(
      <ToolsetsEditor scope={{ kind: 'project', projectId: 'project-1' }} subject="Workshop" />,
    );

    expect(await screen.findByText('workspace-tools')).toBeInTheDocument();
    expect(screen.getByText('Project config · .vscode/mcp.json')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
  });
});
