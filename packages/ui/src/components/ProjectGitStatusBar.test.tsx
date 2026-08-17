import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));

// Radix Popper measures tooltip content with ResizeObserver. jsdom does not
// provide it, so give the focused interaction test the inert browser shape.
vi.stubGlobal(
  'ResizeObserver',
  class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

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

const { ProjectGitStatusBar } = await import('./ProjectGitStatusBar.js');
const { api } = await import('../api.js');

const BASE_STATUS = {
  github: { url: 'https://github.com/foo/bar', lastSyncedAt: new Date().toISOString() },
  exists: true,
  branch: 'main',
  hasPat: true,
};

describe('ProjectGitStatusBar', () => {
  beforeEach(() => {
    vi.mocked(api.getProjectGitStatus).mockResolvedValue(BASE_STATUS as never);
    vi.mocked(api.getProjectIndexStatus).mockResolvedValue({ state: 'fresh' } as never);
  });

  it('shows the plain-language status chip instead of counters', async () => {
    vi.mocked(api.getProjectGitStatus).mockResolvedValue({
      ...BASE_STATUS,
      changesCount: 3,
      ahead: 2,
      behind: 1,
      dirty: true,
    } as never);
    render(<ProjectGitStatusBar projectId="pj-1" />);
    await waitFor(() => {
      expect(screen.getByText('3 unsaved changes · 2 to send · 1 to get')).toBeInTheDocument();
    });
    // The jargon counters are gone for good.
    expect(screen.queryByText('↑2')).not.toBeInTheDocument();
    expect(screen.queryByText('↓1')).not.toBeInTheDocument();
  });

  it('reads "Up to date" with the sync time when there is nothing pending', async () => {
    render(<ProjectGitStatusBar projectId="pj-1" />);
    await waitFor(() => {
      expect(screen.getByText(/Up to date/)).toBeInTheDocument();
    });
  });

  it('shows detailed AI indexing progress in a click-open status panel', async () => {
    vi.mocked(api.getProjectIndexStatus).mockResolvedValue({
      state: 'fresh',
      aiScanPending: true,
      meta: {
        version: 1,
        scannedAt: new Date().toISOString(),
        root: '/workspace',
        durationMs: 1_250,
        fileCount: 24,
        commandCount: 3,
      },
      enrichment: {
        eligible: 20,
        summarized: 12,
        embedded: 15,
        pending: 5,
        reviews: {
          eligible: 20,
          reviewed: 7,
          stale: 2,
          pending: 11,
        },
      },
    } as never);

    render(<ProjectGitStatusBar projectId="pj-1" />);
    // Composite across the pipeline: (12 summarized + 15 embedded +
    // 7 reviewed) / (20 + 20 + 20) → 57%.
    const trigger = await screen.findByRole('button', {
      name: /AI indexing 57% complete/,
    });
    await userEvent.click(trigger);

    const panel = await screen.findByRole('dialog', { name: 'Indexing status' });
    expect(api.getProjectIndexStatus).toHaveBeenCalledTimes(2);
    expect(panel).toHaveTextContent('AI indexing 57% complete');
    expect(panel).toHaveTextContent('Indexing progress');
    expect(screen.getByRole('progressbar', { name: 'Indexing progress' })).toHaveAttribute(
      'aria-valuenow',
      '57',
    );
    expect(panel).toHaveTextContent('15 of 20 files searchable · 5 waiting');
    expect(panel).toHaveTextContent('24 files');
    expect(panel).toHaveTextContent('12 of 20 files');
    expect(panel).toHaveTextContent('7 of 20 · 11 waiting · 2 to refresh');
  });

  it('waits for the panel action before updating the index', async () => {
    render(<ProjectGitStatusBar projectId="pj-1" />);
    const trigger = await screen.findByRole('button', { name: /Workspace index is ready/ });

    await userEvent.click(trigger);
    expect(api.refreshProjectIndex).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Update index now' }));
    await waitFor(() => {
      expect(api.refreshProjectIndex).toHaveBeenCalledWith('pj-1');
    });
  });

  it('shows an intentional opt-out without offering a rescan', async () => {
    vi.mocked(api.getProjectIndexStatus).mockResolvedValue({ state: 'disabled' } as never);

    render(<ProjectGitStatusBar projectId="pj-1" />);
    const trigger = await screen.findByRole('button', {
      name: /Workspace indexing is off/,
    });

    await userEvent.click(trigger);
    expect(screen.getByRole('button', { name: 'Update index now' })).toBeDisabled();
    // No full-bore offer either — opting out means no AI drive of any kind.
    expect(screen.queryByRole('button', { name: 'Full AI scan now' })).toBeNull();
    expect(api.refreshProjectIndex).not.toHaveBeenCalled();
  });

  it('starts a full-intensity drive from the panel and shows it running', async () => {
    vi.mocked(api.driveIndexEnrichment).mockResolvedValue({
      paused: false,
      files: 0,
      summarized: 0,
      embedded: 0,
      pending: 3,
      areasUpdated: 0,
      architectureUpdated: false,
      drained: false,
      started: true,
      alreadyRunning: false,
      mode: 'full',
    } as never);

    render(<ProjectGitStatusBar projectId="pj-1" />);
    const trigger = await screen.findByRole('button', { name: /Workspace index is ready/ });
    await userEvent.click(trigger);

    await userEvent.click(screen.getByRole('button', { name: 'Full AI scan now' }));
    await waitFor(() => {
      expect(api.driveIndexEnrichment).toHaveBeenCalledWith('pj-1', { intensity: 'full' });
    });
    const running = await screen.findByRole('button', { name: 'Full scan running…' });
    expect(running).toBeDisabled();
    // The polite refresh stays independently available.
    expect(screen.getByRole('button', { name: 'Update index now' })).toBeEnabled();
  });

  it("surfaces the server's refusal message when the full scan cannot start", async () => {
    const refusal = Object.assign(new Error('Gezel API error 409'), {
      details: {
        error: 'boekwachter-required',
        message:
          'Add a Boekwachter to this project crew to enable AI summaries, reviews, and semantic enrichment.',
      },
    });
    vi.mocked(api.driveIndexEnrichment).mockRejectedValue(refusal);

    render(<ProjectGitStatusBar projectId="pj-1" />);
    const trigger = await screen.findByRole('button', { name: /Workspace index is ready/ });
    await userEvent.click(trigger);

    await userEvent.click(screen.getByRole('button', { name: 'Full AI scan now' }));
    await screen.findByText(/Add a Boekwachter to this project crew/);
    // A refused start is not a running drive — the button re-arms.
    expect(screen.getByRole('button', { name: 'Full AI scan now' })).toBeEnabled();
  });

  it('reflects a server-side drive: scan row, media tier, disabled button', async () => {
    vi.mocked(api.getProjectIndexStatus).mockResolvedValue({
      state: 'fresh',
      aiScanPending: true,
      aiDrive: 'full',
      enrichment: {
        eligible: 3158,
        summarized: 0,
        embedded: 0,
        pending: 3158,
        shadowsPending: 4,
      },
    } as never);

    render(<ProjectGitStatusBar projectId="pj-1" />);
    const trigger = await screen.findByRole('button', { name: /AI indexing/ });
    await userEvent.click(trigger);

    const panel = await screen.findByRole('dialog', { name: 'Indexing status' });
    expect(panel).toHaveTextContent('AI scan');
    expect(panel).toHaveTextContent('Running at full speed');
    // The media tier runs before summaries — without this row a fresh
    // full scan reads as stuck at "0 of N files".
    expect(panel).toHaveTextContent('Media scan');
    expect(panel).toHaveTextContent('4 waiting');
    // Started elsewhere (another window, catch-up) — the button still
    // reads running and refuses a duplicate start.
    expect(screen.getByRole('button', { name: 'Full scan running…' })).toBeDisabled();
    expect(api.driveIndexEnrichment).not.toHaveBeenCalled();
  });

  it('labels a background drive distinctly', async () => {
    vi.mocked(api.getProjectIndexStatus).mockResolvedValue({
      state: 'fresh',
      aiDrive: 'background',
    } as never);

    render(<ProjectGitStatusBar projectId="pj-1" />);
    const trigger = await screen.findByRole('button', { name: /Workspace index is ready/ });
    await userEvent.click(trigger);

    expect(screen.getByRole('button', { name: 'Background scan running…' })).toBeDisabled();
    expect(screen.getByText('Running quietly in background')).toBeInTheDocument();
  });

  it('flags a waiting merge and clicks through to the GitHub tab', async () => {
    vi.mocked(api.getProjectGitStatus).mockResolvedValue({
      ...BASE_STATUS,
      mergeInProgress: true,
      conflictedCount: 1,
    } as never);
    const onOpenGitHub = vi.fn();
    render(<ProjectGitStatusBar projectId="pj-1" onOpenGitHub={onOpenGitHub} />);
    const chip = await screen.findByText('Sync needs your help');
    await userEvent.click(chip);
    expect(onOpenGitHub).toHaveBeenCalled();
  });

  it('keeps one Sync button and no Save/Share buttons', async () => {
    render(<ProjectGitStatusBar projectId="pj-1" />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Sync' })).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Share' })).not.toBeInTheDocument();
  });

  it('hides ambient Git actions and the default edits-on control in compact mode', async () => {
    vi.mocked(api.getProjectGitStatus).mockResolvedValue({
      ...BASE_STATUS,
      changesCount: 1,
      dirty: true,
    } as never);

    render(
      <ProjectGitStatusBar
        projectId="pj-1"
        compact
        managedWorkspaceWritable
        onManagedWorkspaceWritesChange={vi.fn()}
      />,
    );

    await screen.findByText('main');
    expect(screen.queryByText('1 unsaved change')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sync' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('combobox', {
        name: 'Built-in tool workspace access for this project',
      }),
    ).not.toBeInTheDocument();
  });

  it('keeps the edits-off control visible in compact mode', async () => {
    render(
      <ProjectGitStatusBar
        projectId="pj-1"
        compact
        managedWorkspaceWritable={false}
        onManagedWorkspaceWritesChange={vi.fn()}
      />,
    );

    expect(
      screen.getByRole('combobox', {
        name: 'Built-in tool workspace access for this project',
      }),
    ).toHaveTextContent(/^Read-only$/);
  });

  it('keeps managed tools independently configurable alongside Codex access', async () => {
    const onManagedWorkspaceWritesChange = vi.fn();
    const onCodexModeChange = vi.fn();
    render(
      <ProjectGitStatusBar
        projectId="pj-1"
        managedWorkspaceWritable={false}
        onManagedWorkspaceWritesChange={onManagedWorkspaceWritesChange}
        codexMode="edit"
        onCodexModeChange={onCodexModeChange}
      />,
    );

    const managedControl = screen.getByRole('combobox', {
      name: 'Built-in tool workspace access for this project',
    });
    expect(managedControl).toBeEnabled();
    expect(managedControl).toHaveTextContent(/^Read-only$/);

    const codexControl = screen.getByRole('combobox', {
      name: 'Codex execution mode for this project',
    });
    expect(codexControl).toHaveTextContent('Codex:Edit');

    await userEvent.click(managedControl);
    await userEvent.click(await screen.findByRole('option', { name: 'Can edit' }));
    expect(onManagedWorkspaceWritesChange).toHaveBeenCalledWith(true);

    await userEvent.click(codexControl);
    await userEvent.click(await screen.findByRole('option', { name: 'Reviewed' }));
    expect(onCodexModeChange).toHaveBeenCalledWith('reviewed');
  });

  it('shows and wires Claude access independently from managed tools', async () => {
    const onClaudeModeChange = vi.fn();
    render(
      <ProjectGitStatusBar
        projectId="pj-1"
        managedWorkspaceWritable={false}
        onManagedWorkspaceWritesChange={vi.fn()}
        claudeMode="acceptEdits"
        onClaudeModeChange={onClaudeModeChange}
      />,
    );

    expect(
      screen.getByRole('combobox', {
        name: 'Built-in tool workspace access for this project',
      }),
    ).toHaveTextContent(/^Read-only$/);
    const claudeControl = screen.getByRole('combobox', {
      name: 'Claude execution mode for this project',
    });
    expect(claudeControl).toHaveTextContent('Claude:Edit');
    expect(
      screen.queryByRole('combobox', { name: 'Codex execution mode for this project' }),
    ).not.toBeInTheDocument();

    await userEvent.click(claudeControl);
    await userEvent.click(await screen.findByRole('option', { name: 'Plan' }));
    expect(onClaudeModeChange).toHaveBeenCalledWith('plan');
  });

  it('moves secondary controls into the compact overflow menu', async () => {
    const onStatusChange = vi.fn();
    const onManagedWorkspaceWritesChange = vi.fn();
    render(
      <ProjectGitStatusBar
        projectId="pj-1"
        compact
        status="readonly"
        onStatusChange={onStatusChange}
        managedWorkspaceWritable={false}
        onManagedWorkspaceWritesChange={onManagedWorkspaceWritesChange}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'More project controls' }));
    const overflow = screen.getByRole('group', { name: 'Project controls overflow' });
    expect(within(overflow).getByRole('button', { name: 'Read-only' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await userEvent.click(within(overflow).getByRole('button', { name: 'Active' }));
    expect(onStatusChange).toHaveBeenCalledWith('active');

    await userEvent.click(screen.getByRole('button', { name: 'More project controls' }));
    await userEvent.click(screen.getByRole('button', { name: 'Allow workspace edits' }));
    expect(onManagedWorkspaceWritesChange).toHaveBeenCalledWith(true);
  });

  it('shows both access scopes in the compact overflow for mixed-provider projects', async () => {
    render(
      <ProjectGitStatusBar
        projectId="pj-1"
        compact
        managedWorkspaceWritable={false}
        onManagedWorkspaceWritesChange={vi.fn()}
        codexMode="edit"
        onCodexModeChange={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'More project controls' }));
    const overflow = screen.getByRole('group', { name: 'Project controls overflow' });
    expect(within(overflow).getByText('Built-in tools')).toBeInTheDocument();
    expect(within(overflow).getByText('Codex access')).toBeInTheDocument();
    expect(within(overflow).getByRole('button', { name: 'Edit' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('Sync calls the one-verb endpoint and toasts the plain-language result', async () => {
    vi.mocked(api.syncProjectGit).mockResolvedValue({
      state: 'synced',
      pulled: 0,
      pushed: 2,
    } as never);
    render(<ProjectGitStatusBar projectId="pj-1" />);
    const sync = await screen.findByRole('button', { name: 'Sync' });
    await userEvent.click(sync);
    await waitFor(() => {
      expect(api.syncProjectGit).toHaveBeenCalledWith('pj-1');
    });
    await waitFor(() => {
      expect(screen.getByText('Sent 2 saved changes to GitHub.')).toBeInTheDocument();
    });
  });

  it('hands needs-save off to the GitHub tab', async () => {
    vi.mocked(api.syncProjectGit).mockResolvedValue({
      state: 'needs-save',
      pulled: 0,
      pushed: 0,
    } as never);
    const onOpenGitHub = vi.fn();
    render(<ProjectGitStatusBar projectId="pj-1" onOpenGitHub={onOpenGitHub} />);
    const sync = await screen.findByRole('button', { name: 'Sync' });
    await userEvent.click(sync);
    await waitFor(() => {
      expect(onOpenGitHub).toHaveBeenCalled();
    });
    expect(screen.getByText(/Save your changes first/)).toBeInTheDocument();
  });

  it('hands authentication failures off to the GitHub tab', async () => {
    vi.mocked(api.syncProjectGit).mockResolvedValue({
      state: 'auth',
      pulled: 0,
      pushed: 0,
    } as never);
    const onOpenGitHub = vi.fn();
    render(<ProjectGitStatusBar projectId="pj-1" onOpenGitHub={onOpenGitHub} />);

    await userEvent.click(await screen.findByRole('button', { name: 'Sync' }));

    await waitFor(() => {
      expect(onOpenGitHub).toHaveBeenCalled();
    });
    expect(screen.getByText(/GitHub needs you to sign in again/)).toBeInTheDocument();
  });
});
