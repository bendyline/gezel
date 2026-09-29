import { describe, expect, it } from 'vitest';
import { parseToolEnvelopeReply } from './envelope.js';
import { parseGemmaToolCall } from './gemma-call.js';

describe('Gemma 4 native tool calls', () => {
  it('reads the call Gemma 4 E4B made on a phone', () => {
    // Verbatim from a Galaxy S26+ run (2026-09-27).
    expect(parseGemmaToolCall('<|tool_call>call:list_dir{}<tool_call|>')).toEqual({
      name: 'list_dir',
      arguments: {},
    });
  });

  it('takes <|"|> strings verbatim, with quotes and newlines inside', () => {
    expect(
      parseGemmaToolCall(
        '<|tool_call>call:write_artifact{path:<|"|>announcement.md<|"|>,content:<|"|># Repair Day\nBring "lamps", not fuses.\\n<|"|>,meta:{tags:[<|"|>a<|"|>,2,true,null]},count:3}<tool_call|>',
      ),
    ).toEqual({
      name: 'write_artifact',
      arguments: {
        path: 'announcement.md',
        content: '# Repair Day\nBring "lamps", not fuses.\\n',
        meta: { tags: ['a', 2, true, null] },
        count: 3,
      },
    });
    expect(
      parseGemmaToolCall(
        '<|tool_call>call:list_scripts(project: "Eval script-transform")<tool_call|>',
      ),
    ).toEqual({ name: 'list_scripts', arguments: { project: 'Eval script-transform' } });
    expect(parseGemmaToolCall('<|tool_call>call:read_file{path:"a"(x:1)}')).toBeNull();
    expect(parseGemmaToolCall('<|tool_call>call:read_file{path:"brief.md"}')).toEqual({
      name: 'read_file',
      arguments: { path: 'brief.md' },
    });
  });

  it('never treats anything but one whole call as a call', () => {
    for (const text of [
      'Listing: <|tool_call>call:list_dir{}<tool_call|>',
      '<|tool_call>call:list_dir{}<tool_call|> and then more',
      '<|tool_call>call:write_file{path:<|"|>a.md}<tool_call|>',
      '<|tool_call>call:read_file{path:<|"|>a<|"|>,path:<|"|>b<|"|>}<tool_call|>',
      '<|tool_call>list_dir{}<tool_call|>',
      '<|tool_call>call:ReadFile{}<tool_call|>',
    ])
      expect(parseGemmaToolCall(text)).toBeNull();
  });

  it('runs through the same whole-reply rule as the JSON envelope', () => {
    expect(parseToolEnvelopeReply('  <|tool_call>call:list_dir{}<tool_call|>\n')).toEqual({
      name: 'list_dir',
      arguments: {},
    });
  });
});
