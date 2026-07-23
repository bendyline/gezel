import { describe, expect, it } from 'vitest';
import { parseStreamLine, parseStreamLines } from './stream-parser.js';

describe('parseStreamLine — system init', () => {
  it('captures session id and model', () => {
    const ev = parseStreamLine(
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 'abc-123',
        model: 'claude-opus-4-7',
        tools: ['Read', 'Bash'],
        mcp_servers: [{ name: 'gezel', status: 'connected' }],
      }),
    );
    expect(ev).toEqual({
      kind: 'session-init',
      sessionId: 'abc-123',
      model: 'claude-opus-4-7',
      tools: ['Read', 'Bash'],
      mcpServers: [{ name: 'gezel', status: 'connected' }],
    });
  });

  it('surfaces a malformed event when session_id is missing', () => {
    const ev = parseStreamLine(JSON.stringify({ type: 'system', subtype: 'init' }));
    expect(ev?.kind).toBe('malformed');
  });

  it('returns unknown for system events that are not init', () => {
    const ev = parseStreamLine(JSON.stringify({ type: 'system', subtype: 'compact_boundary' }));
    expect(ev).toEqual({ kind: 'unknown', type: 'system:compact_boundary' });
  });
});

describe('parseStreamLine — assistant blocks', () => {
  it('extracts a text-delta', () => {
    const ev = parseStreamLine(
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] },
      }),
    );
    expect(ev).toEqual({ kind: 'text-delta', text: 'Hello' });
  });

  it('extracts a thinking-delta', () => {
    const ev = parseStreamLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'pondering...' }],
        },
      }),
    );
    expect(ev).toEqual({ kind: 'thinking-delta', text: 'pondering...' });
  });

  it('extracts a tool-use block with parsed input', () => {
    const ev = parseStreamLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_01',
              name: 'Read',
              input: { file_path: '/foo.ts' },
            },
          ],
        },
      }),
    );
    expect(ev).toEqual({
      kind: 'tool-use',
      id: 'toolu_01',
      name: 'Read',
      input: { file_path: '/foo.ts' },
    });
  });
});

describe('parseStreamLine — user/tool_result', () => {
  it('extracts a successful tool-result with string content', () => {
    const ev = parseStreamLine(
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_01',
              content: 'file contents here',
            },
          ],
        },
      }),
    );
    expect(ev).toEqual({
      kind: 'tool-result',
      toolUseId: 'toolu_01',
      isError: false,
      text: 'file contents here',
      images: [],
    });
  });

  it('flags is_error and concatenates text blocks', () => {
    const ev = parseStreamLine(
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_02',
              is_error: true,
              content: [
                { type: 'text', text: 'first ' },
                { type: 'text', text: 'second' },
              ],
            },
          ],
        },
      }),
    );
    expect(ev).toMatchObject({
      kind: 'tool-result',
      toolUseId: 'toolu_02',
      isError: true,
      text: 'first second',
    });
  });

  it('surfaces base64 image content blocks alongside text', () => {
    const ev = parseStreamLine(
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_03',
              content: [
                { type: 'text', text: 'screenshot:' },
                {
                  type: 'image',
                  source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' },
                },
              ],
            },
          ],
        },
      }),
    );
    expect(ev).toMatchObject({
      kind: 'tool-result',
      images: [{ mimeType: 'image/png', base64: 'aGVsbG8=' }],
      text: 'screenshot:',
    });
  });
});

describe('parseStreamLine — result', () => {
  it('parses success result with usage and cost', () => {
    const ev = parseStreamLine(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'final text',
        duration_ms: 1234,
        total_cost_usd: 0.0042,
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 25,
          cache_creation_input_tokens: 10,
        },
        session_id: 'abc-123',
      }),
    );
    expect(ev).toEqual({
      kind: 'result',
      success: true,
      finalText: 'final text',
      durationMs: 1234,
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 25,
      cacheCreationTokens: 10,
      costUsd: 0.0042,
    });
  });

  it('marks failure on non-success subtype', () => {
    const ev = parseStreamLine(
      JSON.stringify({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        duration_ms: 500,
        usage: { input_tokens: 1, output_tokens: 0 },
        session_id: 'abc-123',
      }),
    );
    expect(ev).toMatchObject({ kind: 'result', success: false, durationMs: 500 });
  });
});

describe('parseStreamLine — stream_event (token-granularity)', () => {
  it('extracts a partial text delta from a wrapped content_block_delta', () => {
    const ev = parseStreamLine(
      JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Hey' },
        },
      }),
    );
    expect(ev).toEqual({ kind: 'partial-text-delta', text: 'Hey' });
  });

  it('extracts a partial thinking delta', () => {
    const ev = parseStreamLine(
      JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'considering...' },
        },
      }),
    );
    expect(ev).toEqual({ kind: 'partial-thinking-delta', text: 'considering...' });
  });

  it('returns unknown for non-delta stream_event lifecycle events', () => {
    const ev = parseStreamLine(
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'message_start', message: { id: 'msg_01' } },
      }),
    );
    expect(ev).toEqual({ kind: 'unknown', type: 'stream_event:message_start' });
  });
});

describe('parseStreamLine — robustness', () => {
  it('returns null for empty lines', () => {
    expect(parseStreamLine('')).toBeNull();
    expect(parseStreamLine('   \n')).toBeNull();
  });

  it('returns malformed for non-JSON', () => {
    const ev = parseStreamLine('not json');
    expect(ev?.kind).toBe('malformed');
  });

  it('returns unknown for events with new types', () => {
    const ev = parseStreamLine(JSON.stringify({ type: 'partial_assistant', foo: 'bar' }));
    expect(ev).toEqual({ kind: 'unknown', type: 'partial_assistant' });
  });

  it('parseStreamLines drops nulls and preserves order', () => {
    const lines = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid' }),
      '',
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      }),
    ];
    const events = parseStreamLines(lines);
    expect(events).toHaveLength(2);
    expect(events[0]?.kind).toBe('session-init');
    expect(events[1]?.kind).toBe('text-delta');
  });
});
