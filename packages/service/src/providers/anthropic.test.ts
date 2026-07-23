import { describe, expect, it } from 'vitest';
import { __testing } from './anthropic.js';

const { applyCacheBreakpoints, buildSystem, buildUserMessage, isReasoningModel } = __testing;

describe('anthropic — buildSystem', () => {
  it('returns a single text block with an ephemeral cache breakpoint', () => {
    const out = buildSystem('You are a helpful assistant.');
    expect(out).toEqual([
      {
        type: 'text',
        text: 'You are a helpful assistant.',
        cache_control: { type: 'ephemeral' },
      },
    ]);
  });
});

describe('anthropic — buildUserMessage', () => {
  it('returns a plain string content when no attachments are present', () => {
    expect(buildUserMessage('hello')).toEqual({ role: 'user', content: 'hello' });
  });

  it('wraps the prompt + attachments as a content-block array', () => {
    const message = buildUserMessage('summarise this image', [
      { base64: 'Zm9vYmFy', mimeType: 'image/png', filename: 'screenshot.png' },
    ]);
    expect(message).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'summarise this image' },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'Zm9vYmFy' },
        },
      ],
    });
  });
});

describe('anthropic — applyCacheBreakpoints', () => {
  it('returns the input unchanged when the array is empty', () => {
    expect(applyCacheBreakpoints([])).toEqual([]);
  });

  it('promotes a string-content trailing message into a single cached text block', () => {
    const messages = [
      { role: 'user' as const, content: 'first' },
      { role: 'assistant' as const, content: 'reply' },
      { role: 'user' as const, content: 'next' },
    ];
    const out = applyCacheBreakpoints(messages);
    expect(out).toHaveLength(3);
    // Earlier messages stay verbatim (no cache_control on them).
    expect(out[0]).toEqual({ role: 'user', content: 'first' });
    expect(out[1]).toEqual({ role: 'assistant', content: 'reply' });
    // Trailing message gets rebuilt with a cache breakpoint on its lone block.
    expect(out[2]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'next', cache_control: { type: 'ephemeral' } }],
    });
  });

  it('marks the last block of a structured-content trailing message', () => {
    const messages = [
      {
        role: 'user' as const,
        content: [
          { type: 'text' as const, text: 'first part' },
          { type: 'text' as const, text: 'second part' },
        ],
      },
    ];
    const out = applyCacheBreakpoints(messages);
    expect(out).toHaveLength(1);
    const trailing = out[0]!;
    const blocks = trailing.content as Array<{
      type: string;
      text?: string;
      cache_control?: { type: 'ephemeral' };
    }>;
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ type: 'text', text: 'first part' });
    expect(blocks[1]).toEqual({
      type: 'text',
      text: 'second part',
      cache_control: { type: 'ephemeral' },
    });
  });

  it('does not mutate the input array', () => {
    const messages = [
      { role: 'user' as const, content: 'one' },
      { role: 'assistant' as const, content: 'two' },
    ];
    const before = JSON.parse(JSON.stringify(messages));
    applyCacheBreakpoints(messages);
    expect(messages).toEqual(before);
  });
});

describe('anthropic — isReasoningModel', () => {
  it('marks claude-opus and claude-sonnet 4.x as reasoning-capable', () => {
    expect(isReasoningModel('claude-opus-4-7')).toBe(true);
    expect(isReasoningModel('claude-opus-4-6')).toBe(true);
    expect(isReasoningModel('claude-sonnet-4-6')).toBe(true);
  });

  it('does not mark haiku or unknown model ids', () => {
    expect(isReasoningModel('claude-haiku-4-5')).toBe(false);
    expect(isReasoningModel('claude-3-5-sonnet-20241022')).toBe(false);
    expect(isReasoningModel('not-a-claude-model')).toBe(false);
  });
});
