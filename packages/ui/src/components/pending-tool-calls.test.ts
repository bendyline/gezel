import { describe, expect, it } from 'vitest';
import {
  type PendingToolCall,
  __testing,
  dropExecutedPending,
  formatPendingArgsPreview,
  parsePendingToolCalls,
} from './pending-tool-calls.js';

function pending(name: string, complete: boolean, position = 0): PendingToolCall {
  return { name, params: {}, complete, position };
}

describe('parsePendingToolCalls', () => {
  it('returns empty for text with no markup', () => {
    expect(parsePendingToolCalls('plain prose, no tools')).toEqual([]);
    expect(parsePendingToolCalls('')).toEqual([]);
  });

  it('parses a closed Hermes tool-call block', () => {
    const text =
      '<function=read_task_notes><parameter=ref>atari-combat-clone/3</parameter></function>';
    const result = parsePendingToolCalls(text);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('read_task_notes');
    expect(result[0]!.params).toEqual({ ref: 'atari-combat-clone/3' });
    expect(result[0]!.complete).toBe(true);
  });

  it('parses an in-flight block with no closing </function>', () => {
    const text = '<function=read_file><parameter=path>src/main.ts</parameter>';
    const result = parsePendingToolCalls(text);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('read_file');
    expect(result[0]!.params).toEqual({ path: 'src/main.ts' });
    expect(result[0]!.complete).toBe(false);
  });

  it('parses a bare opener with no params yet', () => {
    const text = 'Some prose...\n<function=write_file>';
    const result = parsePendingToolCalls(text);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('write_file');
    expect(result[0]!.params).toEqual({});
    expect(result[0]!.complete).toBe(false);
  });

  it('parses a partial parameter value mid-stream', () => {
    // The user is watching content stream in token-by-token; the
    // <parameter=path> tag arrived but the value is still arriving.
    const text = '<function=write_file><parameter=path>src/game';
    const result = parsePendingToolCalls(text);
    expect(result).toHaveLength(1);
    expect(result[0]!.params).toEqual({ path: 'src/game' });
  });

  it('parses multiple tool-call blocks stacked in one stream', () => {
    const text = [
      'Let me check the project state.',
      '<function=read_task_notes><parameter=ref>atari/3</parameter></function>',
      '<function=read_task_notes><parameter=ref>atari/1</parameter></function>',
      '<function=read_file><parameter=path>package.json</parameter></function>',
      '<function=read_file><parameter=path>src/main.ts</parameter></function>',
    ].join('\n');
    const result = parsePendingToolCalls(text);
    expect(result).toHaveLength(4);
    expect(result.map((r) => r.name)).toEqual([
      'read_task_notes',
      'read_task_notes',
      'read_file',
      'read_file',
    ]);
    expect(result[0]!.params.ref).toBe('atari/3');
    expect(result[3]!.params.path).toBe('src/main.ts');
  });

  it('handles multiple parameters per call', () => {
    const text =
      '<function=create_task><parameter=project>foo</parameter><parameter=title>bar</parameter></function>';
    const result = parsePendingToolCalls(text);
    expect(result[0]!.params).toEqual({ project: 'foo', title: 'bar' });
  });

  it('marks the last block as in-flight when several stack and the last is open', () => {
    const text = [
      '<function=read_file><parameter=path>a.ts</parameter></function>',
      '<function=write_file><parameter=path>b.ts</parameter><parameter=content>partial...',
    ].join('\n');
    const result = parsePendingToolCalls(text);
    expect(result).toHaveLength(2);
    expect(result[0]!.complete).toBe(true);
    expect(result[1]!.complete).toBe(false);
    expect(result[1]!.params).toMatchObject({ path: 'b.ts' });
  });
});

describe('parsePendingToolCalls — Anthropic invoke shape', () => {
  it('parses a closed invoke with parameters', () => {
    const text = `<invoke name="read_file"><parameter name="path">src/main.ts</parameter></invoke>`;
    const result = parsePendingToolCalls(text);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('read_file');
    expect(result[0]!.params).toEqual({ path: 'src/main.ts' });
    expect(result[0]!.complete).toBe(true);
  });

  it('parses a bare invoke opener mid-stream (no close yet)', () => {
    const text = `<invoke name="write_file"><parameter name="path">src/game.ts`;
    const result = parsePendingToolCalls(text);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('write_file');
    expect(result[0]!.params).toEqual({ path: 'src/game.ts' });
    expect(result[0]!.complete).toBe(false);
  });

  it('parses an invoke wrapped in <function_calls>', () => {
    const text = `<function_calls><invoke name="list_projects"></invoke></function_calls>`;
    const result = parsePendingToolCalls(text);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('list_projects');
    expect(result[0]!.params).toEqual({});
    expect(result[0]!.complete).toBe(true);
  });

  it('parses multiple invokes stacked in a function_calls wrapper', () => {
    const text = [
      '<function_calls>',
      '<invoke name="read_file"><parameter name="path">a.ts</parameter></invoke>',
      '<invoke name="read_file"><parameter name="path">b.ts</parameter></invoke>',
      '</function_calls>',
    ].join('\n');
    const result = parsePendingToolCalls(text);
    expect(result).toHaveLength(2);
    expect(result[0]!.params.path).toBe('a.ts');
    expect(result[1]!.params.path).toBe('b.ts');
  });
});

describe('parsePendingToolCalls — XML self-closing shape', () => {
  it('parses a snake_case self-closing tool tag with attributes', () => {
    const text = `Let me check. <browser_navigate url="https://example.com" />`;
    const result = parsePendingToolCalls(text);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('browser_navigate');
    expect(result[0]!.params).toEqual({ url: 'https://example.com' });
    expect(result[0]!.complete).toBe(true);
  });

  it('parses multiple self-closing tags in source order', () => {
    const text = `<read_task_notes ref="atari/3" /><write_artifact path="notes.md" content="x" />`;
    const result = parsePendingToolCalls(text);
    expect(result).toHaveLength(2);
    expect(result[0]!.name).toBe('read_task_notes');
    expect(result[0]!.params).toEqual({ ref: 'atari/3' });
    expect(result[1]!.name).toBe('write_artifact');
    expect(result[1]!.params).toEqual({ path: 'notes.md', content: 'x' });
  });

  it('REJECTS plain HTML (no underscore in tag name) to avoid false positives in code blocks', () => {
    const text = `<div class="card" /><br /><svg xmlns="http://x" />`;
    expect(parsePendingToolCalls(text)).toEqual([]);
  });

  it('REJECTS camelCase tool names — they slip through (acceptable; salvage catches post-stream)', () => {
    // Documenting expected behavior: `<readFile path="..." />` is
    // indistinguishable from a custom React component without a tool
    // registry. Pending UI doesn't show it; the user sees it briefly
    // then the salvage layer promotes it after the iteration ends.
    const text = `<readFile path="src/main.ts" />`;
    expect(parsePendingToolCalls(text)).toEqual([]);
  });

  it('handles single-quoted attribute values', () => {
    // Actually the parser only matches double quotes by design (mirrors
    // the salvage layer's strictness). Document that.
    const text = `<browser_navigate url='https://example.com' />`;
    expect(parsePendingToolCalls(text)).toEqual([]);
  });
});

describe('parsePendingToolCalls — JSON envelope shape', () => {
  it('parses a `{"tool":"NAME","args":{...}}` envelope', () => {
    const text = `Let me try this:\n\n{"tool": "read_file", "args": {"path": "src/main.ts"}}`;
    const result = parsePendingToolCalls(text);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('read_file');
    expect(result[0]!.params).toEqual({ path: 'src/main.ts' });
    expect(result[0]!.complete).toBe(true);
  });

  it('parses the `{"name":"NAME","arguments":{...}}` variant', () => {
    const text = `{"name": "write_file", "arguments": {"path": "x.ts", "content": "y"}}`;
    const result = parsePendingToolCalls(text);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('write_file');
    expect(result[0]!.params).toEqual({ path: 'x.ts', content: 'y' });
  });

  it('parses multiple envelopes stacked in a code chain', () => {
    const text = [
      '```json',
      '{"tool": "list_projects", "args": {}}',
      '```',
      '```json',
      '{"tool": "create_project", "args": {"name": "X"}}',
      '```',
    ].join('\n');
    const result = parsePendingToolCalls(text);
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.name)).toEqual(['list_projects', 'create_project']);
  });

  it('does NOT match a plain JSON object without the name+args pair', () => {
    const text = `Here's my config: {"timeout": 5000, "retries": 3}`;
    expect(parsePendingToolCalls(text)).toEqual([]);
  });

  it('serializes non-string param values for the preview', () => {
    const text = `{"tool": "spawn_task_instances", "args": {"count": 5, "ref": "atari/3"}}`;
    const result = parsePendingToolCalls(text);
    expect(result[0]!.params).toEqual({ count: '5', ref: 'atari/3' });
  });
});

describe('parsePendingToolCalls — mixed shapes', () => {
  it('returns all shapes in source-position order', () => {
    const text = [
      'First, the Hermes form:',
      '<function=read_task_notes><parameter=ref>atari/3</parameter></function>',
      'Then Anthropic invoke:',
      '<invoke name="read_file"><parameter name="path">a.ts</parameter></invoke>',
      'Then XML self-closing:',
      '<browser_navigate url="https://x.com" />',
      'Then JSON envelope:',
      '{"tool": "write_file", "args": {"path": "out.txt"}}',
    ].join('\n');
    const result = parsePendingToolCalls(text);
    expect(result).toHaveLength(4);
    expect(result.map((r) => r.name)).toEqual([
      'read_task_notes',
      'read_file',
      'browser_navigate',
      'write_file',
    ]);
  });
});

describe('parsePendingToolCalls — edge cases', () => {
  it('returns empty for plain prose with no markup', () => {
    expect(parsePendingToolCalls("Here's how the algorithm works...")).toEqual([]);
    expect(parsePendingToolCalls('')).toEqual([]);
  });

  it('individual parsers are independent (testing seam)', () => {
    const text = '<function=foo><parameter=k>v</parameter></function>';
    expect(__testing.parseHermesPending(text)).toHaveLength(1);
    expect(__testing.parseAnthropicInvokePending(text)).toHaveLength(0);
    expect(__testing.parseXmlSelfClosingPending(text)).toHaveLength(0);
    expect(__testing.parseJsonEnvelopePending(text)).toHaveLength(0);
  });
});

describe('formatPendingArgsPreview', () => {
  it('returns empty when no params present', () => {
    expect(formatPendingArgsPreview({})).toBe('');
  });

  it('prefers a "path" param over an arbitrary one', () => {
    expect(formatPendingArgsPreview({ extra: 'x', path: 'src/main.ts' })).toBe('path: src/main.ts');
  });

  it('prefers "ref" over "name" when both present', () => {
    expect(formatPendingArgsPreview({ name: 'x', ref: 'atari/3' })).toBe('ref: atari/3');
  });

  it('falls back to the first param when no priority key matches', () => {
    expect(formatPendingArgsPreview({ widget: 'square' })).toBe('widget: square');
  });

  it('truncates long values so a write_file content blob does not overflow', () => {
    const long = 'a'.repeat(200);
    const out = formatPendingArgsPreview({ content: long });
    expect(out.length).toBeLessThan(100);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('dropExecutedPending', () => {
  it('returns the input unchanged when nothing has executed yet', () => {
    const list = [pending('read_file', true), pending('write_file', true)];
    expect(dropExecutedPending(list, 0)).toEqual(list);
  });

  it('drops the leading N complete pendings once the salvage layer fires', () => {
    const list = [
      pending('read_file', true),
      pending('write_file', true),
      pending('listDir', true),
    ];
    expect(dropExecutedPending(list, 2).map((p) => p.name)).toEqual(['listDir']);
  });

  it('drops all pendings when every one has been executed', () => {
    const list = [pending('a', true), pending('b', true), pending('c', true)];
    expect(dropExecutedPending(list, 3)).toEqual([]);
    // Over-counting (e.g., extra native tool calls without markup) is safe.
    expect(dropExecutedPending(list, 99)).toEqual([]);
  });

  it('never consumes a streaming (incomplete) pending — salvage only fires on closed markup', () => {
    const list = [
      pending('read_file', true), // already executed
      pending('write_file', false), // still streaming, must survive
    ];
    const out = dropExecutedPending(list, 1);
    expect(out.map((p) => [p.name, p.complete])).toEqual([['write_file', false]]);
  });

  it('skips streaming entries when accounting for executed completes', () => {
    // Mid-flight scenario: 1st block streamed in + closed → executed.
    // 2nd block is mid-stream. 3rd block already closed but salvage
    // hasn't run again yet. With executedCount=1, the first complete
    // is consumed, the streaming one survives, and the unfired
    // complete remains visible as queued.
    const list = [
      pending('read_file', true, 0),
      pending('write_file', false, 100),
      pending('listDir', true, 200),
    ];
    const out = dropExecutedPending(list, 1);
    expect(out.map((p) => p.name)).toEqual(['write_file', 'listDir']);
  });
});
