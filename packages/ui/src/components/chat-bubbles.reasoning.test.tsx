import type { ChatMessageToolCall } from '@bendyline/gezel';
import { render, screen } from '@testing-library/react';
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
        reasoning="One careful thought."
      />,
    );

    expect(screen.getByText('· 3 words')).toBeInTheDocument();
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
    expect(mark).toHaveTextContent('read_file · path: "about.md"');
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
