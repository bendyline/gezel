import type { TerminalTimelineEntry } from '@bendyline/gezel';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TerminalBubble } from './TerminalBubble.js';
import { TerminalStreamingBubble } from './TerminalStreamingBubble.js';

const OUTPUT_ENTRY: TerminalTimelineEntry = {
  threadId: 'terminal-root',
  projectId: 'project-1',
  workingDir: '',
  threadCreatedAt: '2026-07-29T12:00:00.000Z',
  threadLastActivityAt: '2026-07-29T12:00:01.000Z',
  messageId: 'message-1',
  msgKind: 'output',
  content: 'Name            Length\nalpha.txt       123',
  at: '2026-07-29T12:00:01.000Z',
  exitCode: 0,
};

describe('TerminalBubble', () => {
  it('preserves output text and exposes the scrollable pane to keyboard users', () => {
    render(<TerminalBubble entry={OUTPUT_ENTRY} />);

    const output = screen.getByRole('region', { name: 'Terminal output' });
    expect(output).toHaveClass('terminal-output-viewport');
    expect(output).toHaveAttribute('tabindex', '0');
    expect(output.querySelector('.terminal-output-body')?.textContent).toBe(OUTPUT_ENTRY.content);
  });
});

describe('TerminalStreamingBubble', () => {
  const baseProps = {
    cwd: '',
    startedAt: '2026-07-29T12:00:00.000Z',
  };

  it('follows new output until the user scrolls away, then resumes at the bottom', () => {
    const { rerender } = render(
      <TerminalStreamingBubble {...baseProps} content={'first line\n'} />,
    );
    const output = screen.getByRole('region', {
      name: 'Live terminal output',
    });

    Object.defineProperties(output, {
      scrollHeight: { configurable: true, value: 400 },
      clientHeight: { configurable: true, value: 100 },
    });

    output.scrollTop = 0;
    rerender(<TerminalStreamingBubble {...baseProps} content={'first line\nsecond line\n'} />);
    expect(output.scrollTop).toBe(400);

    output.scrollTop = 0;
    fireEvent.scroll(output);
    rerender(
      <TerminalStreamingBubble {...baseProps} content={'first line\nsecond line\nthird line\n'} />,
    );
    expect(output.scrollTop).toBe(0);

    output.scrollTop = 300;
    fireEvent.scroll(output);
    rerender(
      <TerminalStreamingBubble
        {...baseProps}
        content={'first line\nsecond line\nthird line\nfourth line\n'}
      />,
    );
    expect(output.scrollTop).toBe(400);
  });

  it('reparses the complete buffer when an ANSI escape arrives across chunks', () => {
    const { rerender } = render(
      <TerminalStreamingBubble {...baseProps} content={'plain \x1b[31'} />,
    );
    const output = screen.getByRole('region', { name: 'Live terminal output' });
    expect(output.textContent).toBe('plain ');

    rerender(<TerminalStreamingBubble {...baseProps} content={'plain \x1b[31mred\x1b[0m'} />);
    expect(output.textContent).toBe('plain red');
    expect(output.querySelector('.ansi-fg-red')?.textContent).toBe('red');
  });
});
