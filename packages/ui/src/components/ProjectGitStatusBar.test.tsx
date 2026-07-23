import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
    vi.mocked(api.getProjectGithubStatus).mockResolvedValue(BASE_STATUS as never);
    vi.mocked(api.getProjectIndexStatus).mockResolvedValue({ state: 'fresh' } as never);
  });

  it('shows the plain-language status chip instead of counters', async () => {
    vi.mocked(api.getProjectGithubStatus).mockResolvedValue({
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

  it('shows detailed AI indexing progress in a fast tooltip', async () => {
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
    const trigger = await screen.findByRole('button', {
      name: /AI indexing 75% complete/,
    });
    await userEvent.hover(trigger);

    const tooltip = await screen.findByRole('tooltip');
    expect(api.getProjectIndexStatus).toHaveBeenCalledTimes(2);
    expect(tooltip).toHaveTextContent('AI indexing 75% complete');
    expect(tooltip).toHaveTextContent('15 of 20 files ready · 5 waiting');
    expect(tooltip).toHaveTextContent('24 files · 3 commands');
    expect(tooltip).toHaveTextContent('12 of 20 files');
    expect(tooltip).toHaveTextContent('7 of 20 · 11 waiting · 2 to refresh');
  });

  it('flags a waiting merge and clicks through to the GitHub tab', async () => {
    vi.mocked(api.getProjectGithubStatus).mockResolvedValue({
      ...BASE_STATUS,
      mergeInProgress: true,
      conflictedCount: 1,
    } as never);
    const onOpenGithub = vi.fn();
    render(<ProjectGitStatusBar projectId="pj-1" onOpenGithub={onOpenGithub} />);
    const chip = await screen.findByText('Sync needs your help');
    await userEvent.click(chip);
    expect(onOpenGithub).toHaveBeenCalled();
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
    vi.mocked(api.getProjectGithubStatus).mockResolvedValue({
      ...BASE_STATUS,
      changesCount: 1,
      dirty: true,
    } as never);

    render(
      <ProjectGitStatusBar
        projectId="pj-1"
        compact
        allowGezelWrites
        onAllowWritesChange={vi.fn()}
      />,
    );

    await screen.findByText('main');
    expect(screen.queryByText('1 unsaved change')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sync' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('combobox', { name: 'Gezel file edits for this project' }),
    ).not.toBeInTheDocument();
  });

  it('keeps the edits-off control visible in compact mode', async () => {
    render(
      <ProjectGitStatusBar
        projectId="pj-1"
        compact
        allowGezelWrites={false}
        onAllowWritesChange={vi.fn()}
      />,
    );

    expect(
      screen.getByRole('combobox', { name: 'Gezel file edits for this project' }),
    ).toHaveTextContent('Edits off');
  });

  it('moves secondary controls into the compact overflow menu', async () => {
    const onStatusChange = vi.fn();
    const onAllowWritesChange = vi.fn();
    render(
      <ProjectGitStatusBar
        projectId="pj-1"
        compact
        status="readonly"
        onStatusChange={onStatusChange}
        allowGezelWrites={false}
        onAllowWritesChange={onAllowWritesChange}
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
    await userEvent.click(screen.getByRole('button', { name: 'Turn edits on' }));
    expect(onAllowWritesChange).toHaveBeenCalledWith(true);
  });

  it('Sync calls the one-verb endpoint and toasts the plain-language result', async () => {
    vi.mocked(api.syncProjectGithub).mockResolvedValue({
      state: 'synced',
      pulled: 0,
      pushed: 2,
    } as never);
    render(<ProjectGitStatusBar projectId="pj-1" />);
    const sync = await screen.findByRole('button', { name: 'Sync' });
    await userEvent.click(sync);
    await waitFor(() => {
      expect(api.syncProjectGithub).toHaveBeenCalledWith('pj-1');
    });
    await waitFor(() => {
      expect(screen.getByText('Sent 2 saved changes to GitHub.')).toBeInTheDocument();
    });
  });

  it('hands needs-save off to the GitHub tab', async () => {
    vi.mocked(api.syncProjectGithub).mockResolvedValue({
      state: 'needs-save',
      pulled: 0,
      pushed: 0,
    } as never);
    const onOpenGithub = vi.fn();
    render(<ProjectGitStatusBar projectId="pj-1" onOpenGithub={onOpenGithub} />);
    const sync = await screen.findByRole('button', { name: 'Sync' });
    await userEvent.click(sync);
    await waitFor(() => {
      expect(onOpenGithub).toHaveBeenCalled();
    });
    expect(screen.getByText(/Save your changes first/)).toBeInTheDocument();
  });
});
