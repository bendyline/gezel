import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ToolDiffBlock } from './ToolDiffBlock.js';

const FIXTURE_DIFF = [
  '--- a/notes.md',
  '+++ b/notes.md',
  '@@ -1,3 +1,3 @@',
  ' line one',
  '-line two',
  '+LINE TWO',
  ' line three',
].join('\n');

describe('ToolDiffBlock', () => {
  it('renders the +N −M counts in the collapsed-toggle label', () => {
    render(<ToolDiffBlock diff={FIXTURE_DIFF} addedLines={1} removedLines={1} />);
    expect(screen.getByRole('button')).toHaveTextContent(/Show diff.*\+1.*−1/);
  });

  it('hides the diff body until expanded', () => {
    render(<ToolDiffBlock diff={FIXTURE_DIFF} />);
    expect(screen.queryByText('+LINE TWO')).toBeNull();
  });

  it('reveals the diff body with proper add/remove classes when expanded', () => {
    const { container } = render(<ToolDiffBlock diff={FIXTURE_DIFF} />);
    fireEvent.click(screen.getByRole('button'));
    expect(container.querySelector('.thinking-tool-diff-line-add')).toHaveTextContent('+LINE TWO');
    expect(container.querySelector('.thinking-tool-diff-line-rem')).toHaveTextContent('-line two');
    expect(container.querySelector('.thinking-tool-diff-line-hunk')).toHaveTextContent(
      '@@ -1,3 +1,3 @@',
    );
  });

  it('strips the ---/+++ preamble — the tool row already shows the path', () => {
    const { container } = render(<ToolDiffBlock diff={FIXTURE_DIFF} />);
    fireEvent.click(screen.getByRole('button'));
    expect(container.querySelector('.thinking-tool-diff-line-header')).toBeNull();
    expect(screen.queryByText('--- a/notes.md')).toBeNull();
  });

  it('renders a diff without hunk markers unchanged', () => {
    const headerOnly = ['--- a/notes.md', '+++ b/notes.md'].join('\n');
    const { container } = render(<ToolDiffBlock diff={headerOnly} />);
    fireEvent.click(screen.getByRole('button'));
    expect(container.querySelectorAll('.thinking-tool-diff-line-header')).toHaveLength(2);
  });

  it('toggles back to collapsed on a second click', () => {
    render(<ToolDiffBlock diff={FIXTURE_DIFF} />);
    fireEvent.click(screen.getByRole('button'));
    fireEvent.click(screen.getByRole('button'));
    expect(screen.queryByText('+LINE TWO')).toBeNull();
  });

  it('omits the counts label when neither addedLines nor removedLines is set', () => {
    render(<ToolDiffBlock diff={FIXTURE_DIFF} />);
    expect(screen.getByRole('button')).toHaveTextContent(/Show diff$/);
  });
});
