import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { GitDiffView } from './GitDiffView.js';

const DIFF = [
  '--- a/notes.md',
  '+++ b/notes.md',
  '@@ -2,3 +2,3 @@',
  ' context line',
  '-old line',
  '+new line',
  '@@ -20,2 +20,2 @@',
  ' more context',
  '+added below',
].join('\n');

describe('GitDiffView', () => {
  it('renders add/remove lines with their classes and hides @@ headers', () => {
    const { container } = render(<GitDiffView diff={DIFF} />);
    expect(container.querySelector('.git-diff-line-add')?.textContent).toContain('new line');
    expect(container.querySelector('.git-diff-line-rem')?.textContent).toContain('old line');
    expect(container.textContent).not.toContain('@@');
  });

  it('humanizes the gap between hunks as an unchanged-lines separator', () => {
    render(<GitDiffView diff={DIFF} />);
    // Hunk 1 ends at old line 3; hunk 2 starts at 20 → 16 unchanged.
    expect(screen.getByText(/16 unchanged lines/)).toBeInTheDocument();
  });

  it('shows the binary placeholder instead of a diff', () => {
    render(<GitDiffView diff={DIFF} binary />);
    expect(screen.getByText(/isn't text/)).toBeInTheDocument();
    expect(screen.queryByText(/new line/)).not.toBeInTheDocument();
  });

  it('frames deleted and renamed files', () => {
    const { rerender } = render(<GitDiffView diff={DIFF} kind="deleted" />);
    expect(screen.getByText('This file was deleted.')).toBeInTheDocument();
    rerender(<GitDiffView diff={DIFF} kind="renamed" oldPath="old/notes.md" />);
    expect(screen.getByText(/Moved from/)).toBeInTheDocument();
  });

  it('collapses very large diffs behind a Show everything button', async () => {
    const big = `@@ -1,600 +1,600 @@\n${Array.from({ length: 600 }, (_, i) => ` line ${i}`).join('\n')}`;
    const { container } = render(<GitDiffView diff={big} />);
    expect(container.querySelectorAll('.git-diff-line')).toHaveLength(500);
    await userEvent.click(screen.getByRole('button', { name: 'Show everything' }));
    expect(container.querySelectorAll('.git-diff-line')).toHaveLength(600);
  });

  it('notes backend truncation even when everything received is shown', () => {
    render(<GitDiffView diff={DIFF} truncated />);
    expect(screen.getByText(/big change/)).toBeInTheDocument();
  });
});
