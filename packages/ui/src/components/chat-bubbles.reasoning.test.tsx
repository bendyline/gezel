import type { ChatMessageToolCall } from '@bendyline/gezel';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MessageBubble, spliceReasoningMarks } from './chat-bubbles.js';

vi.mock('../theme.js', () => ({ useEffectiveTheme: () => 'light' }));

describe('MessageBubble reasoning summary', () => {
  it('shows a subtle word count and observed duration while collapsed', () => {
    render(
      // biome-ignore lint/a11y/useValidAriaRole: MessageBubble's domain role selects the message author; it is not forwarded as an ARIA role.
      <MessageBubble
        role="assistant"
        content="Done."
        authorLabel="Ada"
        authorIcon={null}
        debugMode
        reasoning="First I inspect, then I answer."
        reasoningDurationMs={1_250}
      />,
    );

    const label = screen.getByText('Thinking');
    const summary = label.closest('summary');
    expect(summary).toHaveTextContent('Thinking');
    expect(screen.getByText('· 6 words · 1.3s')).toBeInTheDocument();
    expect(summary?.parentElement).not.toHaveAttribute('open');
  });

  it('omits duration when the provider did not expose timing data', () => {
    render(
      // biome-ignore lint/a11y/useValidAriaRole: MessageBubble's domain role selects the message author; it is not forwarded as an ARIA role.
      <MessageBubble
        role="assistant"
        content="Done."
        authorLabel="Ada"
        authorIcon={null}
        debugMode
        reasoning="One careful thought."
      />,
    );

    expect(screen.getByText('· 3 words')).toBeInTheDocument();
  });
});

describe('MessageBubble details outside debug mode', () => {
  // "1 step · 785ms total" and "Thinking · 129 words · 19.7s" headed every
  // reply a newcomer read (2026-10-11).
  it('keeps steps and thinking behind the reply’s Details key', () => {
    render(
      // biome-ignore lint/a11y/useValidAriaRole: MessageBubble's domain role selects the message author; it is not forwarded as an ARIA role.
      <MessageBubble
        role="assistant"
        content="Done."
        authorLabel="Ada"
        authorIcon={null}
        reasoning="First I inspect, then I answer."
        toolCalls={[{ name: 'read_file', durationMs: 785, success: true }]}
      />,
    );
    expect(screen.queryByText('Thinking')).not.toBeInTheDocument();
    expect(screen.queryByText(/785ms total/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(screen.getByText('Thinking')).toBeInTheDocument();
    expect(screen.getByText(/1 step/)).toBeInTheDocument();
  });

  it('still shows a failure the turn never recovered from', () => {
    render(
      // biome-ignore lint/a11y/useValidAriaRole: MessageBubble's domain role selects the message author; it is not forwarded as an ARIA role.
      <MessageBubble
        role="assistant"
        content="Done."
        authorLabel="Ada"
        authorIcon={null}
        toolCalls={[
          { name: 'write_file', durationMs: 12, success: false, errorMessage: 'disk is read-only' },
        ]}
      />,
    );
    expect(screen.getByText(/disk is read-only/)).toBeInTheDocument();
  });
});

describe('spliceReasoningMarks', () => {
  const call = (over: Partial<ChatMessageToolCall> = {}): ChatMessageToolCall => ({
    name: 'read_file',
    durationMs: 12,
    success: true,
    ...over,
  });

  it('returns the whole trace unmarked when no call recorded an offset', () => {
    expect(spliceReasoningMarks('abcdef', [call()])).toEqual([{ text: 'abcdef' }]);
  });

  it('cuts the trace at each recorded offset', () => {
    const tools = [
      call({ name: 'read_file', afterReasoningChars: 3 }),
      call({ name: 'write_file', afterReasoningChars: 5 }),
    ];
    expect(spliceReasoningMarks('abcdef', tools)).toEqual([
      { text: 'abc', mark: tools[0] },
      { text: 'de', mark: tools[1] },
      { text: 'f' },
    ]);
  });

  it('shifts offsets by the leading whitespace the render trims away', () => {
    // Offsets index the raw trace; the expander renders `trim()`ed text,
    // so an unshifted mark would land two characters late.
    const tools = [call({ afterReasoningChars: 5 })];
    const parts = spliceReasoningMarks('  abcdef  ', tools);
    expect(parts[0]?.text).toBe('abc');
    expect(parts[1]?.text).toBe('def');
  });

  it('sorts and clamps offsets so a stale one cannot slice backwards', () => {
    // A continuation is a fresh iteration with its own trace — an offset
    // captured against a longer earlier string outruns this one.
    const tools = [call({ afterReasoningChars: 99 }), call({ afterReasoningChars: 2 })];
    const parts = spliceReasoningMarks('abcd', tools);
    expect(parts.map((p) => p.text)).toEqual(['ab', 'cd', '']);
  });
});

describe('MessageBubble reasoning marks', () => {
  it('splices a tool breadcrumb into the trace where the call fired', () => {
    render(
      // biome-ignore lint/a11y/useValidAriaRole: MessageBubble's domain role selects the message author; it is not forwarded as an ARIA role.
      <MessageBubble
        role="assistant"
        content="Done."
        authorLabel="Ada"
        authorIcon={null}
        debugMode
        reasoning="I should look at the file. Now I know."
        toolCalls={[
          {
            name: 'read_file',
            durationMs: 12,
            success: true,
            argsSummary: 'path: "about.md"',
            afterReasoningChars: 27,
          },
        ]}
      />,
    );

    const mark = screen.getByTitle('read_file ran here');
    expect(mark).toHaveTextContent('read_file · path: about.md');
    // The trace itself still reads as one continuous block around it.
    expect(mark.closest('pre')).toHaveTextContent('I should look at the file.');
    expect(mark.closest('pre')).toHaveTextContent('Now I know.');
  });

  it('marks a failed call distinctly', () => {
    render(
      // biome-ignore lint/a11y/useValidAriaRole: MessageBubble's domain role selects the message author; it is not forwarded as an ARIA role.
      <MessageBubble
        role="assistant"
        content="Done."
        authorLabel="Ada"
        authorIcon={null}
        debugMode
        reasoning="Try the craftbook."
        toolCalls={[
          {
            name: 'invoke_craftbook',
            durationMs: 33_000,
            success: false,
            errorMessage: 'assignee.kind="gezel" requires gezelId',
            afterReasoningChars: 18,
          },
        ]}
      />,
    );

    const mark = screen.getByTitle(
      'invoke_craftbook failed here: assignee.kind="gezel" requires gezelId',
    );
    expect(mark).toHaveClass('failed');
  });
});
