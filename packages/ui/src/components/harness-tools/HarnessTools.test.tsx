import type { HarnessToolsClientStatus, HarnessToolsStatusResponse } from '@bendyline/gezel';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api.js', () => ({
  api: { listProjects: vi.fn().mockResolvedValue({ projects: [{ id: 'p1', name: 'Website' }] }) },
}));

vi.mock('../ConfirmDialog.js', () => ({
  ConfirmDialog: ({
    open,
    title,
    message,
    confirmLabel,
    onConfirm,
  }: {
    open: boolean;
    title: string;
    message?: React.ReactNode;
    confirmLabel?: string;
    onConfirm: () => void;
  }) =>
    open ? (
      <div role="alertdialog" aria-label={title}>
        {message}
        <button type="button" onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    ) : null,
}));

const { HarnessToolsSection } = await import('./HarnessToolsSection.js');
const { HarnessToolsOverview } = await import('./HarnessToolsOverview.js');
type Tools = import('./useHarnessTools.js').HarnessTools;

function client(overrides: Partial<HarnessToolsClientStatus>): HarnessToolsClientStatus {
  return {
    client: 'cursor',
    label: 'Cursor',
    state: 'not-configured',
    configPath: '/me/.cursor/mcp.json',
    reasons: [],
    canConfigure: true,
    canRemove: false,
    ...overrides,
  };
}

function tools(
  clients: HarnessToolsClientStatus[],
  extra: Partial<HarnessToolsStatusResponse> = {},
): Tools {
  const status: HarnessToolsStatusResponse = {
    config: { enabled: true, memory: 'save', images: 'local', newFolders: 'add' },
    clients,
    connections: [],
    blocked: [],
    ...extra,
  };
  return {
    status,
    error: null,
    busy: null,
    refresh: vi.fn(),
    updateConfig: vi.fn().mockResolvedValue(undefined),
    configure: vi.fn().mockResolvedValue(true),
    remove: vi.fn().mockResolvedValue(true),
    stop: vi.fn().mockResolvedValue(undefined),
    unblock: vi.fn().mockResolvedValue(undefined),
    client: (id) => clients.find((c) => c.client === id),
  };
}

beforeEach(() => {
  (window as unknown as { __GEZEL__: { mode: string } }).__GEZEL__ = { mode: 'local-adopt' };
});

afterEach(() => {
  delete (window as unknown as { __GEZEL__?: unknown }).__GEZEL__;
});

describe('an app’s tools section', () => {
  it('sets Cursor up after naming the file it changes', async () => {
    const t = tools([client({})]);
    render(<HarnessToolsSection client="cursor" tools={t} />);
    expect(screen.getByRole('heading', { name: "Gezel's tools in Cursor" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: "Set up Gezel's tools…" }));
    const dialog = screen.getByRole('alertdialog', { name: "Set up Gezel's tools in Cursor?" });
    expect(dialog).toHaveTextContent('/me/.cursor/mcp.json');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Set up' }));
    expect(t.configure).toHaveBeenCalledWith('cursor', {});
  });

  it('offers to replace a gezel entry it did not write, keeping a backup', () => {
    const t = tools([
      client({
        state: 'conflict',
        reasons: ['Cursor already has a server called gezel that Gezel did not set up.'],
      }),
    ]);
    render(<HarnessToolsSection client="cursor" tools={t} />);
    expect(screen.getByText(/did not set up/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Replace it…' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Replace the gezel server in Cursor?' });
    expect(dialog).toHaveTextContent('.backup');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Replace' }));
    expect(t.configure).toHaveBeenCalledWith('cursor', { replaceExisting: true });
  });

  it('shows the command to run by hand when the app’s own command is missing', () => {
    const t = tools([
      client({
        client: 'claude-code',
        label: 'Claude Code',
        state: 'unavailable',
        canConfigure: false,
        configPath: '/me/.claude.json',
        reasons: ['Gezel could not find the claude command.'],
        manualCommand: 'claude mcp add --scope user gezel -- node launch.mjs --harness claude-code',
      }),
    ]);
    render(<HarnessToolsSection client="claude-code" tools={t} />);
    expect(screen.getByText('To set it up yourself, run')).toBeInTheDocument();
    expect(screen.getByText(/claude mcp add --scope user gezel/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Set up/ })).not.toBeInTheDocument();
  });

  it('says one-click setup needs the desktop app on this computer', () => {
    (window as unknown as { __GEZEL__: { mode: string } }).__GEZEL__ = { mode: 'remote' };
    render(<HarnessToolsSection client="cursor" tools={tools([client({})])} />);
    expect(screen.getByText(/connected to a remote Gezel service/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: "Set up Gezel's tools…" })).toBeDisabled();
  });
});

describe('the Overview section', () => {
  it('saves each choice and turns the tools off', () => {
    const t = tools([]);
    render(<HarnessToolsOverview tools={t} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Read' }));
    expect(t.updateConfig).toHaveBeenCalledWith({ memory: 'read' });
    fireEvent.click(screen.getByRole('radio', { name: 'Any image engine' }));
    expect(t.updateConfig).toHaveBeenCalledWith({ images: 'any' });
    fireEvent.click(screen.getByRole('radio', { name: 'Only folders already in Gezel' }));
    expect(t.updateConfig).toHaveBeenCalledWith({ newFolders: 'existing' });
    fireEvent.click(screen.getByRole('checkbox', { name: "Let other apps use Gezel's tools" }));
    expect(t.updateConfig).toHaveBeenCalledWith({ enabled: false });
  });

  it('lists apps in use, stops one for its folder, and turns a stopped one back on', () => {
    const t = tools([], {
      connections: [
        {
          appId: 'harness:cursor:p1',
          client: 'cursor',
          label: 'Cursor',
          projectId: 'p1',
          projectName: 'Website',
          folder: '/work/site',
          createdAt: 1,
          lastUsedAt: Date.now(),
        },
      ],
      blocked: [{ client: 'codex', projectId: 'p2', label: 'Codex', projectName: 'Notes' }],
    });
    render(<HarnessToolsOverview tools={t} />);
    const table = screen.getByRole('table', { name: "Apps using Gezel's tools" });
    expect(within(table).getByText('Website')).toBeInTheDocument();
    fireEvent.click(within(table).getByRole('button', { name: 'Stop Cursor in Website' }));
    expect(t.stop).toHaveBeenCalledWith('harness:cursor:p1');
    fireEvent.click(screen.getByRole('button', { name: 'Turn back on' }));
    expect(t.unblock).toHaveBeenCalledWith({ client: 'codex', projectId: 'p2' });
  });
});
