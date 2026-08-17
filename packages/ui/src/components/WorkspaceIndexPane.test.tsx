import type { BoekwachterIssue } from '@bendyline/gezel';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceIndexPane } from './WorkspaceIndexPane.js';

vi.mock('./MarkdownField.js', () => ({
  MarkdownField: ({ value }: { value: string }) => <div>{value}</div>,
}));

const openIssue: BoekwachterIssue = {
  id: 'issue-8',
  ref: 'BW-8',
  fingerprint: 'fingerprint-8',
  path: 'docs/guide.md',
  line: 26,
  severity: 'minor',
  category: 'clarity',
  message: 'The conclusion does not identify an owner.',
  status: 'open',
  seen: false,
  stale: true,
  createdAt: '2026-08-11T00:00:00.000Z',
  lastSeenAt: '2026-08-11T00:00:00.000Z',
};

describe('WorkspaceIndexPane Boekwachter lifecycle', () => {
  it('labels historical anchors and exposes read, dismissal, resolution, and fix actions', async () => {
    const onUpdateIssue = vi.fn().mockResolvedValue(undefined);
    const onFixIssue = vi.fn();
    const onSelectLine = vi.fn();
    render(
      <WorkspaceIndexPane
        path="docs/guide.md"
        status={null}
        issues={null}
        review={{ path: 'docs/guide.md', found: false, trackedIssues: [openIssue] }}
        loading={false}
        error={null}
        onClose={vi.fn()}
        onSelectLine={onSelectLine}
        onFixIssue={onFixIssue}
        onUpdateIssue={onUpdateIssue}
      />,
    );

    expect(screen.getByText('BW-8')).toBeInTheDocument();
    expect(screen.getByText('Previously line 26')).toBeInTheDocument();
    expect(screen.getByText('Needs recheck')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Previously line 26/ }));
    expect(onSelectLine).toHaveBeenCalledWith(26);
    await waitFor(() => expect(onUpdateIssue).toHaveBeenCalledWith(openIssue, { seen: true }));

    fireEvent.click(screen.getByRole('button', { name: 'Not an issue' }));
    await waitFor(() =>
      expect(onUpdateIssue).toHaveBeenCalledWith(openIssue, {
        status: 'dismissed',
        seen: true,
        dismissalReason: 'not_an_issue',
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Mark resolved' }));
    await waitFor(() =>
      expect(onUpdateIssue).toHaveBeenCalledWith(openIssue, {
        status: 'resolved',
        seen: true,
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Fix' }));
    expect(onFixIssue).toHaveBeenCalledWith(openIssue);
  });

  it('renders the row actions as icon keys in a tray named for the issue', () => {
    render(
      <WorkspaceIndexPane
        path="docs/guide.md"
        status={null}
        issues={null}
        review={{ path: 'docs/guide.md', found: false, trackedIssues: [openIssue] }}
        loading={false}
        error={null}
        onClose={vi.fn()}
        onFixIssue={vi.fn()}
        onUpdateIssue={vi.fn()}
      />,
    );

    // The ref lives on the toolbar, so the keys inside can keep short labels
    // without a screen reader hearing "Mark resolved" identically per row.
    const tray = screen.getByRole('toolbar', { name: 'Actions for BW-8' });
    expect(tray).toHaveClass('gz-tray');

    const resolve = screen.getByRole('button', { name: 'Mark resolved' });
    expect(resolve).toHaveClass('gz-key', 'gz-key--icon');
    expect(resolve.querySelector('i')).toHaveClass('fa-solid', 'fa-check');
    // Icon-only: no visible text competing with the issue message.
    expect(resolve.textContent).toBe('');
    expect(resolve).toHaveAttribute('title', 'Mark resolved');

    expect(screen.getByRole('button', { name: 'Mark read' }).querySelector('i')).toHaveClass(
      'fa-envelope-open',
    );
    expect(screen.getByRole('button', { name: 'Not an issue' }).querySelector('i')).toHaveClass(
      'fa-ban',
    );

    const fix = screen.getByRole('button', { name: 'Fix' });
    expect(fix.querySelector('i')).toHaveClass('fa-wrench');
    expect(fix).toHaveAttribute('title', 'Create a tracked task for BW-8');
  });

  it('hides closed history until requested and links an in-progress issue to its task', () => {
    const onOpenTask = vi.fn();
    render(
      <WorkspaceIndexPane
        path="docs/guide.md"
        status={null}
        issues={null}
        review={{
          path: 'docs/guide.md',
          found: false,
          trackedIssues: [
            { ...openIssue, id: 'resolved', ref: 'BW-9', status: 'resolved', seen: true },
            {
              ...openIssue,
              id: 'working',
              ref: 'BW-10',
              status: 'in_progress',
              taskRef: 'project/4',
            },
          ],
        }}
        loading={false}
        error={null}
        onClose={vi.fn()}
        onUpdateIssue={vi.fn()}
        onOpenTask={onOpenTask}
      />,
    );

    expect(screen.queryByText('BW-9')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show closed' }));
    expect(screen.getByText('BW-9')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reopen' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Working · project/4' }));
    expect(onOpenTask).toHaveBeenCalledWith('project/4');
  });
});
