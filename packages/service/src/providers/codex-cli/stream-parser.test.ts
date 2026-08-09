import { describe, expect, it } from 'vitest';
import { parseCodexLine, parseCodexLines } from './stream-parser.js';

describe('parseCodexLine', () => {
  it('returns null for empty / whitespace-only lines', () => {
    expect(parseCodexLine('')).toBeNull();
    expect(parseCodexLine('   \t')).toBeNull();
  });

  it('flags malformed JSON', () => {
    const ev = parseCodexLine('{not json');
    expect(ev?.kind).toBe('malformed');
  });

  it('flags non-object top-level values', () => {
    const ev = parseCodexLine('42');
    expect(ev?.kind).toBe('malformed');
  });

  it('parses thread.started with thread_id', () => {
    const ev = parseCodexLine('{"type":"thread.started","thread_id":"abc-123"}');
    expect(ev).toEqual({ kind: 'thread-started', threadId: 'abc-123' });
  });

  it('also accepts threadId camelCase variant', () => {
    const ev = parseCodexLine('{"type":"thread.started","threadId":"xyz"}');
    expect(ev).toEqual({ kind: 'thread-started', threadId: 'xyz' });
  });

  it('flags thread.started missing thread id as malformed', () => {
    const ev = parseCodexLine('{"type":"thread.started"}');
    expect(ev?.kind).toBe('malformed');
  });

  it('parses turn.started', () => {
    expect(parseCodexLine('{"type":"turn.started"}')).toEqual({ kind: 'turn-started' });
  });

  it('parses item.started for an agent_message', () => {
    const ev = parseCodexLine('{"type":"item.started","item":{"id":"i1","type":"agent_message"}}');
    expect(ev?.kind).toBe('item-started');
    if (ev?.kind !== 'item-started') return;
    expect(ev.itemId).toBe('i1');
    expect(ev.itemType).toBe('agent_message');
  });

  it('parses item.updated and pulls text from agent_message', () => {
    const ev = parseCodexLine(
      '{"type":"item.updated","item":{"id":"i1","type":"agent_message","text":"Hello, "}}',
    );
    expect(ev?.kind).toBe('item-updated');
    if (ev?.kind !== 'item-updated') return;
    expect(ev.text).toBe('Hello, ');
  });

  it('parses item.completed for agent_message with full text', () => {
    const ev = parseCodexLine(
      '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"Hello, world."}}',
    );
    expect(ev?.kind).toBe('item-completed');
    if (ev?.kind !== 'item-completed') return;
    expect(ev.text).toBe('Hello, world.');
    expect(ev.itemType).toBe('agent_message');
  });

  it('extracts tool name from mcp_tool_call items', () => {
    const ev = parseCodexLine(
      '{"type":"item.completed","item":{"id":"i2","type":"mcp_tool_call","tool":"search_memory"}}',
    );
    if (ev?.kind !== 'item-completed') throw new Error('expected item-completed');
    expect(ev.itemType).toBe('mcp_tool_call');
    expect(ev.text).toBe('search_memory');
  });

  it('still accepts the older MCP name field', () => {
    const ev = parseCodexLine(
      '{"type":"item.completed","item":{"id":"i2","type":"mcp_tool_call","name":"save_memory"}}',
    );
    if (ev?.kind !== 'item-completed') throw new Error('expected item-completed');
    expect(ev.text).toBe('save_memory');
  });

  it('extracts command from command_execution items when text absent', () => {
    const ev = parseCodexLine(
      '{"type":"item.completed","item":{"id":"i3","type":"command_execution","command":"ls -la"}}',
    );
    if (ev?.kind !== 'item-completed') throw new Error('expected item-completed');
    expect(ev.text).toBe('ls -la');
  });

  it('parses turn.completed and surfaces token usage', () => {
    const ev = parseCodexLine(
      '{"type":"turn.completed","usage":{"input_tokens":42,"cached_input_tokens":7,"output_tokens":19}}',
    );
    expect(ev).toEqual({
      kind: 'turn-completed',
      inputTokens: 42,
      cachedInputTokens: 7,
      outputTokens: 19,
    });
  });

  it('defaults missing usage fields to zero', () => {
    const ev = parseCodexLine('{"type":"turn.completed"}');
    expect(ev).toEqual({
      kind: 'turn-completed',
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
    });
  });

  it('parses turn.failed with nested error.message', () => {
    const ev = parseCodexLine('{"type":"turn.failed","error":{"message":"thread not found"}}');
    expect(ev).toEqual({ kind: 'turn-failed', message: 'thread not found' });
  });

  it('parses error events', () => {
    const ev = parseCodexLine('{"type":"error","message":"rate limit"}');
    expect(ev).toEqual({ kind: 'error', message: 'rate limit' });
  });

  it('marks unknown event types as unknown', () => {
    const ev = parseCodexLine('{"type":"future.event"}');
    expect(ev).toEqual({ kind: 'unknown', type: 'future.event' });
  });

  it('marks unrecognized item types as unknown but still extracts ids', () => {
    const ev = parseCodexLine(
      '{"type":"item.completed","item":{"id":"x","type":"future_item","text":"hi"}}',
    );
    if (ev?.kind !== 'item-completed') throw new Error('expected item-completed');
    expect(ev.itemType).toBe('unknown');
    expect(ev.itemId).toBe('x');
    expect(ev.text).toBe('hi');
  });
});

describe('parseCodexLines', () => {
  it('preserves order and drops nulls', () => {
    const events = parseCodexLines([
      '',
      '{"type":"thread.started","thread_id":"t1"}',
      '   ',
      '{"type":"turn.completed"}',
    ]);
    expect(events).toHaveLength(2);
    expect(events[0]?.kind).toBe('thread-started');
    expect(events[1]?.kind).toBe('turn-completed');
  });
});
