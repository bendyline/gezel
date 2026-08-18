import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ToolHistoryExpando, unresolvedToolFailures } from './chat-bubbles.js';

describe('ToolHistoryExpando result details', () => {
  it('shows both the request and a short response in details', () => {
    render(
      <ToolHistoryExpando
        tools={[
          {
            name: 'suggest_craftbook',
            durationMs: 42,
            success: true,
            argsFull: 'query: create a PowerPoint',
            resultText: 'Matched presentations/powerpoint',
          },
        ]}
      />,
    );

    fireEvent.click(screen.getByText('1 step'));
    fireEvent.click(screen.getByRole('button', { name: 'details' }));

    expect(screen.getByText('Request')).toBeInTheDocument();
    expect(screen.getByText('query: create a PowerPoint')).toBeInTheDocument();
    expect(screen.getByText('Response')).toBeInTheDocument();
    expect(screen.getByText('Matched presentations/powerpoint')).toBeInTheDocument();
  });

  it('labels a bounded long response as a summary', () => {
    render(
      <ToolHistoryExpando
        tools={[
          {
            name: 'list_dir',
            durationMs: 42,
            success: true,
            resultText: 'Long response: 900 lines. Showing the beginning and end.',
            resultTruncated: true,
          },
        ]}
      />,
    );

    fireEvent.click(screen.getByText('1 step'));
    fireEvent.click(screen.getByRole('button', { name: 'details' }));

    expect(screen.getByText('Response summary')).toBeInTheDocument();
  });

  /**
   * The hover preview must render OUTSIDE the chat's scrolling subtree.
   * An absolutely-positioned preview inside it still counts toward the
   * scroll container's `scrollHeight`, so showing it tripped
   * ChatTimelineView's stick-to-bottom effect: the timeline scrolled,
   * the toggle moved out from under the cursor, the preview hid, the
   * height shrank back — a hover/scroll flicker loop.
   */
  it('renders the hover preview in a body-level portal, not inside the tool list', () => {
    const { container } = render(
      <ToolHistoryExpando
        tools={[
          {
            name: 'suggest_craftbook',
            durationMs: 42,
            success: true,
            argsFull: 'query: create a PowerPoint',
          },
        ]}
      />,
    );

    fireEvent.click(screen.getByText('1 step'));
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'details' }));

    const preview = screen.getByRole('tooltip');
    expect(preview).toHaveTextContent('query: create a PowerPoint');
    expect(container.contains(preview)).toBe(false);
    expect(preview.closest('.thinking-tool-detail')).toBeNull();

    fireEvent.mouseLeave(screen.getByRole('button', { name: 'details' }));
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});

/**
 * A completion gate that rejects a step used to reach the user as a red ✗
 * and nothing else: the reason sat in `title` and the details drawer,
 * both behind a closed expando. Watching a task retry six times with no
 * stated cause is the failure mode these tests pin shut.
 */
describe('unrecovered tool failures', () => {
  const GATE_REJECTION =
    '[gate_rejected] Step "scan" on squisq/5 was NOT completed — its gate rejected the work (attempt 1/6):\n\n' +
    '- pr-review-coverage.json: reviewed 25 path(s), but the connector corpus contains 68.\n' +
    'Retryable: true';

  it('shows the reason outside the expando, so a closed disclosure still tells the user why', () => {
    const { container } = render(
      <ToolHistoryExpando
        tools={[
          { name: 'read_artifact', durationMs: 12, success: true },
          {
            name: 'advance_task_step',
            durationMs: 900,
            success: false,
            errorMessage: GATE_REJECTION,
          },
        ]}
      />,
    );

    const notice = container.querySelector('.msg-tool-failure');
    expect(notice).not.toBeNull();
    // Outside <details> is what makes it visible while collapsed — jsdom
    // renders the closed expando's children either way, so the assertion
    // has to be structural rather than a text lookup.
    expect(notice?.closest('.msg-tool-history')).toBeNull();
    expect(notice).toHaveTextContent('Advance task step');
    expect(notice).toHaveTextContent('reviewed 25 path(s), but the connector corpus contains 68');
    expect(notice?.textContent).not.toContain('[gate_rejected]');
    expect(notice?.textContent).not.toContain('Retryable:');
  });

  it('stays quiet when the model retried the same tool successfully', () => {
    const { container } = render(
      <ToolHistoryExpando
        tools={[
          { name: 'write_artifact', durationMs: 30, success: false, errorMessage: 'Bad path' },
          { name: 'write_artifact', durationMs: 30, success: true },
        ]}
      />,
    );

    expect(container.querySelector('.msg-tool-failure')).toBeNull();
    // The row inside the expando still explains itself — only the
    // thread-level notice is reserved for failures nothing recovered.
    expect(screen.getByText('Bad path')).toBeInTheDocument();
  });

  it('repeats the reason on the failed row inside the expando', () => {
    render(
      <ToolHistoryExpando
        tools={[
          {
            name: 'advance_task_step',
            durationMs: 900,
            success: false,
            errorMessage: GATE_REJECTION,
          },
        ]}
      />,
    );

    fireEvent.click(screen.getByText('1 step'));
    expect(document.querySelectorAll('.thinking-tool-error')).toHaveLength(1);
  });

  it('resolves a failure only against a later success of the same tool', () => {
    expect(
      unresolvedToolFailures([
        { name: 'advance_task_step', success: false, errorMessage: 'gate said no' },
        { name: 'write_task_note', success: true },
      ]).map((f) => f.name),
    ).toEqual(['advance_task_step']);
  });

  it('ignores a failure the provider reported without any message', () => {
    expect(unresolvedToolFailures([{ name: 'run_git', success: false }])).toEqual([]);
  });
});
