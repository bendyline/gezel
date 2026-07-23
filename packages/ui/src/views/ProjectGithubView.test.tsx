import type { ProjectDetail } from '@bendyline/gezel';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';
import { primitivesMock } from '../test-utils/primitivesMock.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));
vi.mock('../primitives/index.js', () => primitivesMock);

// The shell composes the heavy sub-views; stub them so these tests stay
// about tab routing, banners, and state takeover (each child has its
// own test file).
vi.mock('../components/github/GitChangesView.js', () => ({
  GitChangesView: () => <div data-testid="changes-view" />,
}));
vi.mock('../components/github/ConflictResolutionView.js', () => ({
  ConflictResolutionView: ({ resumed }: { resumed: boolean }) => (
    <div data-testid="conflict-view" data-resumed={resumed} />
  ),
}));
vi.mock('../components/github/GitTimelineView.js', () => ({
  GitTimelineView: () => <div data-testid="timeline-view" />,
}));
vi.mock('../components/github/PullRequestsView.js', () => ({
  PullRequestsView: () => <div data-testid="prs-view" />,
}));

const { ProjectGithubView } = await import('./ProjectGithubView.js');
const { api } = await import('../api.js');

const PROJECT: ProjectDetail = {
  id: 'pj-alpha',
  name: 'Alpha',
  github: {
    url: 'https://github.com/foo/bar',
    lastSyncedAt: new Date().toISOString(),
  },
} as ProjectDetail;

describe('ProjectGithubView', () => {
  beforeEach(() => {
    vi.mocked(api.getProjectGithubStatus).mockResolvedValue({
      exists: true,
      branch: 'main',
      hasPat: true,
      changesCount: 2,
    } as never);
    vi.mocked(api.fetchProjectGithub).mockResolvedValue({ ok: true, fetched: false } as never);
    vi.mocked(api.getProject).mockResolvedValue(PROJECT as never);
    vi.mocked(api.cloneProjectGithub).mockResolvedValue({ ok: true } as never);
  });

  it('defaults to the Changes sub-tab with a change-count badge', async () => {
    render(<ProjectGithubView project={PROJECT} onProjectChange={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByTestId('changes-view')).toBeInTheDocument();
    });
    const changesTab = screen
      .getAllByRole('tab')
      .find((el) => el.getAttribute('data-value') === 'changes');
    expect(changesTab?.textContent).toContain('2');
  });

  it('switches between Timeline and Pull requests', async () => {
    render(<ProjectGithubView project={PROJECT} onProjectChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('changes-view')).toBeInTheDocument());

    const tabs = screen.getAllByRole('tab');
    fireEvent.click(tabs.find((el) => el.getAttribute('data-value') === 'timeline')!);
    expect(screen.getByTestId('timeline-view')).toBeInTheDocument();

    fireEvent.click(tabs.find((el) => el.getAttribute('data-value') === 'prs')!);
    expect(screen.getByTestId('prs-view')).toBeInTheDocument();
  });

  it('offers Download project when no checkout exists, then clones', async () => {
    vi.mocked(api.getProjectGithubStatus).mockResolvedValue({
      exists: false,
      hasPat: true,
    } as never);
    const onProjectChange = vi.fn();
    render(<ProjectGithubView project={PROJECT} onProjectChange={onProjectChange} />);
    await waitFor(() => {
      expect(screen.getByText(/isn't on this computer yet/)).toBeInTheDocument();
    });

    vi.mocked(api.getProjectGithubStatus).mockResolvedValue({
      exists: true,
      branch: 'main',
      hasPat: true,
    } as never);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Download project' }));
    await waitFor(() => {
      expect(api.cloneProjectGithub).toHaveBeenCalledWith('pj-alpha');
    });
    expect(onProjectChange).toHaveBeenCalled();
  });

  it('shows the no-credentials banner when there is no PAT or ambient sign-in', async () => {
    vi.mocked(api.getProjectGithubStatus).mockResolvedValue({
      exists: true,
      branch: 'main',
      hasPat: false,
      credentialSource: 'none',
    } as never);
    render(<ProjectGithubView project={PROJECT} onProjectChange={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText(/No GitHub sign-in found/)).toBeInTheDocument();
    });
  });

  it('hides the credentials banner when the GitHub CLI is signed in (no PAT)', async () => {
    vi.mocked(api.getProjectGithubStatus).mockResolvedValue({
      exists: true,
      branch: 'main',
      hasPat: false,
      credentialSource: 'gh',
    } as never);
    render(<ProjectGithubView project={PROJECT} onProjectChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('changes-view')).toBeInTheDocument());
    expect(screen.queryByText(/No GitHub sign-in found/)).not.toBeInTheDocument();
  });

  it('replaces the Changes pane with the conflict flow while a merge is in progress', async () => {
    vi.mocked(api.getProjectGithubStatus).mockResolvedValue({
      exists: true,
      branch: 'main',
      hasPat: true,
      mergeInProgress: true,
      conflictedCount: 1,
    } as never);
    render(<ProjectGithubView project={PROJECT} onProjectChange={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByTestId('conflict-view')).toBeInTheDocument();
    });
    // No sync was clicked this mount — the wizard shows its resume intro.
    expect(screen.getByTestId('conflict-view').dataset.resumed).toBe('true');
    expect(screen.queryByTestId('changes-view')).not.toBeInTheDocument();
  });

  it('nudges to sync when GitHub has new changes', async () => {
    vi.mocked(api.getProjectGithubStatus).mockResolvedValue({
      exists: true,
      branch: 'main',
      hasPat: true,
      behind: 2,
    } as never);
    vi.mocked(api.syncProjectGithub).mockResolvedValue({
      state: 'synced',
      pulled: 2,
      pushed: 0,
    } as never);
    render(<ProjectGithubView project={PROJECT} onProjectChange={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText(/New changes from GitHub are available/)).toBeInTheDocument();
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Sync' }));
    await waitFor(() => {
      expect(api.syncProjectGithub).toHaveBeenCalledWith('pj-alpha');
    });
    await waitFor(() => {
      expect(screen.getByText('Got 2 new changes from GitHub.')).toBeInTheDocument();
    });
  });
});
