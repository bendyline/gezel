import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';
import { primitivesMock } from '../test-utils/primitivesMock.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));
vi.mock('../primitives/index.js', () => primitivesMock);
vi.mock('./CatalogBrowser.js', () => ({
  CatalogBrowser: () => <div data-testid="catalog-browser" />,
}));

const { ToolsetsEditor } = await import('./ToolsetsEditor.js');
const { api } = await import('../api.js');

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
