import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../../test-utils/mockApi.js';
import { primitivesMock } from '../../test-utils/primitivesMock.js';

vi.mock('../../api.js', () => ({ api: createMockApi() }));
vi.mock('../../primitives/index.js', () => primitivesMock);

const { GitChangesView } = await import('./GitChangesView.js');
const { api } = await import('../../api.js');

const CHANGES = [
  { path: 'src/app.ts', kind: 'modified' as const, additions: 3, deletions: 1 },
  { path: 'docs/new-page.md', kind: 'added' as const, additions: 12, deletions: 0 },
];

function renderView(overrides: Partial<Parameters<typeof GitChangesView>[0]> = {}) {
  const props = {
    projectId: 'pj-1',
    onSyncRequested: vi.fn(),
    syncing: false,
    showToast: vi.fn(),
    ...overrides,
  };
  render(<GitChangesView {...props} />);
  return props;
}

describe('GitChangesView', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.mocked(api.getProjectGithubChanges).mockResolvedValue({
      changes: CHANGES,
      total: 2,
      truncated: false,
    } as never);
    vi.mocked(api.getProjectGithubFileDiff).mockResolvedValue({
      path: 'src/app.ts',
      kind: 'modified',
      binary: false,
      truncated: false,
      diff: '@@ -1,2 +1,2 @@\n-removed line\n+added line\n',
    } as never);
    vi.mocked(api.commitProjectGithub).mockResolvedValue({
      ok: true,
      sha: 'abc',
      filesChanged: 2,
    } as never);
    vi.mocked(api.discardProjectGithubChanges).mockResolvedValue({
      ok: true,
      discarded: 1,
    } as never);
    vi.mocked(api.suggestProjectGithubMessage).mockResolvedValue({ message: '' } as never);
  });

  it('lists changed files with stats and auto-selects the first for its diff', async () => {
    renderView();
    await waitFor(() => {
      expect(screen.getByText('app.ts')).toBeInTheDocument();
    });
    expect(screen.getByText('new-page.md')).toBeInTheDocument();
    expect(screen.getByText('2 changed files')).toBeInTheDocument();
    await waitFor(() => {
      expect(api.getProjectGithubFileDiff).toHaveBeenCalledWith('pj-1', 'src/app.ts');
    });
    await waitFor(() => {
      expect(screen.getByText(/added line/)).toBeInTheDocument();
    });
  });

  it('saves with the typed message and requests a sync when "also send" is on', async () => {
    const props = renderView();
    await waitFor(() => expect(screen.getByText('app.ts')).toBeInTheDocument());
    const user = userEvent.setup();
    await user.type(
      screen.getByRole('textbox', { name: 'Describe what you changed' }),
      'Reworked the intro',
    );
    await user.click(screen.getByRole('button', { name: 'Save & sync' }));
    await waitFor(() => {
      expect(api.commitProjectGithub).toHaveBeenCalledWith('pj-1', 'Reworked the intro');
    });
    expect(props.onSyncRequested).toHaveBeenCalled();
    expect(props.showToast).toHaveBeenCalledWith('ok', 'Saved.');
  });

  it('falls back to an auto-generated description when the box is empty', async () => {
    renderView();
    await waitFor(() => expect(screen.getByText('app.ts')).toBeInTheDocument());
    const user = userEvent.setup();
    await user.click(screen.getByLabelText('Also send to GitHub now'));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => {
      expect(api.commitProjectGithub).toHaveBeenCalledWith(
        'pj-1',
        'Updated app.ts and 1 more file',
      );
    });
  });

  it('discards a single file behind a confirm dialog', async () => {
    renderView();
    await waitFor(() => expect(screen.getByText('app.ts')).toBeInTheDocument());
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Undo changes to app.ts' }));
    expect(screen.getByText('Undo changes to app.ts?')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Undo changes' }));
    await waitFor(() => {
      expect(api.discardProjectGithubChanges).toHaveBeenCalledWith('pj-1', {
        paths: ['src/app.ts'],
      });
    });
  });

  it('discards everything via the Undo all flow', async () => {
    renderView();
    await waitFor(() => expect(screen.getByText('app.ts')).toBeInTheDocument());
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Undo all…' }));
    await user.click(screen.getByRole('button', { name: 'Undo everything' }));
    await waitFor(() => {
      expect(api.discardProjectGithubChanges).toHaveBeenCalledWith('pj-1', { all: true });
    });
  });

  it('shows the all-saved empty state with a Sync affordance', async () => {
    vi.mocked(api.getProjectGithubChanges).mockResolvedValue({
      changes: [],
      total: 0,
      truncated: false,
    } as never);
    const props = renderView({ lastSyncedAt: new Date().toISOString() });
    await waitFor(() => {
      expect(screen.getByText('All changes saved ✓')).toBeInTheDocument();
    });
    expect(screen.getByText(/Last synced/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Sync' }));
    expect(props.onSyncRequested).toHaveBeenCalled();
  });
});
