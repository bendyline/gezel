import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../../test-utils/mockApi.js';
import { primitivesMock } from '../../test-utils/primitivesMock.js';

vi.mock('../../api.js', () => ({ api: createMockApi() }));
vi.mock('../../primitives/index.js', () => primitivesMock);

const { ConflictResolutionView } = await import('./ConflictResolutionView.js');
const { api } = await import('../../api.js');

const TWO_CONFLICTS = [
  { path: 'README.md', kind: 'both-modified' as const },
  { path: 'notes.txt', kind: 'both-modified' as const },
];

function renderView(overrides: Partial<Parameters<typeof ConflictResolutionView>[0]> = {}) {
  const props = {
    projectId: 'pj-1',
    resumed: false,
    showToast: vi.fn(),
    onFinished: vi.fn(),
    onExited: vi.fn(),
    ...overrides,
  };
  render(<ConflictResolutionView {...props} />);
  return props;
}

describe('ConflictResolutionView', () => {
  beforeEach(() => {
    vi.mocked(api.getProjectGitMergeState).mockResolvedValue({
      inMerge: true,
      conflicts: TWO_CONFLICTS,
    } as never);
    vi.mocked(api.getProjectGitConflictVersions).mockResolvedValue({
      path: 'README.md',
      base: 'base text',
      ours: 'our text',
      theirs: 'their text',
      binary: false,
      tooLarge: false,
    } as never);
    vi.mocked(api.resolveProjectGitConflict).mockResolvedValue({
      ok: true,
      remaining: 1,
    } as never);
    vi.mocked(api.completeProjectGitMerge).mockResolvedValue({
      ok: true,
      sha: 'abc',
    } as never);
    vi.mocked(api.abandonProjectGitMerge).mockResolvedValue({ ok: true } as never);
    vi.mocked(api.aiResolveProjectGitConflict).mockResolvedValue({
      path: 'README.md',
      merged: 'combined text',
    } as never);
  });

  it('lists the overlapping files and shows both versions of the selected one', async () => {
    renderView();
    await waitFor(() => {
      expect(
        screen.getByText("Your changes and GitHub's changes overlap in 2 files"),
      ).toBeInTheDocument();
    });
    // The selected file's versions load after the conflict list does.
    await waitFor(() => {
      expect(screen.getByText('our text')).toBeInTheDocument();
    });
    expect(screen.getByText('their text')).toBeInTheDocument();
    expect(screen.getByText('0 of 2 sorted out')).toBeInTheDocument();
  });

  it('keep-mine posts the resolution and advances; Finish stays gated until all are sorted', async () => {
    renderView();
    await waitFor(() => expect(screen.getByText('our text')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Finish sync' })).toBeDisabled();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Keep my version' }));
    await waitFor(() => {
      expect(api.resolveProjectGitConflict).toHaveBeenCalledWith('pj-1', {
        path: 'README.md',
        choice: 'mine',
      });
    });
    expect(screen.getByText('1 of 2 sorted out')).toBeInTheDocument();
    expect(screen.getByText('Kept yours')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Finish sync' })).toBeDisabled();

    // Auto-advanced to notes.txt — settle it too, then Finish unlocks.
    await waitFor(() => expect(screen.getByText('our text')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: "Keep GitHub's version" }));
    await waitFor(() => {
      expect(screen.getByText('2 of 2 sorted out')).toBeInTheDocument();
    });
    const finish = screen.getByRole('button', { name: 'Finish sync' });
    expect(finish).toBeEnabled();
    await user.click(finish);
    await waitFor(() => {
      expect(api.completeProjectGitMerge).toHaveBeenCalledWith('pj-1');
    });
  });

  it('AI combine previews the merged content and applies it as a custom resolution', async () => {
    renderView();
    await waitFor(() => expect(screen.getByText('our text')).toBeInTheDocument());
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Combine them with AI/ }));
    await waitFor(() => {
      expect(screen.getByText('combined text')).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: 'Use this' }));
    await waitFor(() => {
      expect(api.resolveProjectGitConflict).toHaveBeenCalledWith('pj-1', {
        path: 'README.md',
        choice: 'custom',
        content: 'combined text',
      });
    });
  });

  it('Cancel sync confirms before abandoning the merge', async () => {
    const props = renderView();
    await waitFor(() => expect(screen.getByText('our text')).toBeInTheDocument());
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Cancel sync' }));
    expect(screen.getByText('Stop syncing?')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Yes, cancel sync' }));
    await waitFor(() => {
      expect(api.abandonProjectGitMerge).toHaveBeenCalledWith('pj-1');
    });
    expect(props.onExited).toHaveBeenCalled();
  });

  it('shows the resume intro when re-entering after a restart', async () => {
    renderView({ resumed: true });
    await waitFor(() => {
      expect(screen.getByText(/middle of a sync/)).toBeInTheDocument();
    });
  });

  it('exits immediately when no merge is actually in progress', async () => {
    vi.mocked(api.getProjectGitMergeState).mockResolvedValue({
      inMerge: false,
      conflicts: [],
    } as never);
    const props = renderView();
    await waitFor(() => {
      expect(props.onExited).toHaveBeenCalled();
    });
  });
});
