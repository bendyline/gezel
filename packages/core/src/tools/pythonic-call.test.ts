import { describe, expect, it } from 'vitest';
import { parseToolEnvelopeReply } from './envelope.js';
import { parsePythonicToolCall } from './pythonic-call.js';

describe('Python-style tool calls', () => {
  it('reads the calls LFM2.5 made on a phone', () => {
    // Verbatim from a Galaxy S26+ run (2026-09-26).
    expect(parsePythonicToolCall("[read_file(path='brief.md')]")).toEqual({
      name: 'read_file',
      arguments: { path: 'brief.md' },
    });
    expect(
      parsePythonicToolCall(
        "[save_memory(text='Repair cabinet access phrase: ORCHARD-7284. Responsible person: Noor.', scope='project')]",
      ),
    ).toEqual({
      name: 'save_memory',
      arguments: {
        text: 'Repair cabinet access phrase: ORCHARD-7284. Responsible person: Noor.',
        scope: 'project',
      },
    });
    expect(
      parsePythonicToolCall("[search(query='repair cabinet decision project', maxResults=10)]"),
    ).toEqual({
      name: 'search',
      arguments: { query: 'repair cabinet decision project', maxResults: 10 },
    });
  });

  it('reads Python literals, escapes and the model markers', () => {
    expect(
      parsePythonicToolCall(
        '<|tool_call_start|>[write_file(path="a.js", content=\'const s = \\\'x\\\';\\nok\', overwrite=True, meta={"tags": ["a", 2, None]},)]<|tool_call_end|>',
      ),
    ).toEqual({
      name: 'write_file',
      arguments: {
        path: 'a.js',
        content: "const s = 'x';\nok",
        overwrite: true,
        meta: { tags: ['a', 2, null] },
      },
    });
    expect(parsePythonicToolCall('[list_dir()]')).toEqual({ name: 'list_dir', arguments: {} });
    expect(parsePythonicToolCall('[f(x=-1.5e3, y=False)]')).toEqual({
      name: 'f',
      arguments: { x: -1500, y: false },
    });
  });

  it('never treats anything but one whole call as a call', () => {
    for (const text of [
      "I will read it: [read_file(path='brief.md')]",
      "[read_file(path='a.md'), read_file(path='b.md')]",
      "[read_file('brief.md')]",
      "[read_file(path='brief.md')",
      "[read_file(path='brief.md', path='other.md')]",
      "[ReadFile(path='brief.md')]",
      "[read_file(path=open('x'))]",
      '[]',
    ])
      expect(parsePythonicToolCall(text)).toBeNull();
  });

  it('runs through the same whole-reply rule as the JSON envelope', () => {
    expect(parseToolEnvelopeReply("```python\n[read_file(path='brief.md')]\n```")).toEqual({
      name: 'read_file',
      arguments: { path: 'brief.md' },
    });
    expect(parseToolEnvelopeReply("Example:\n```\n[read_file(path='brief.md')]\n```")).toBeNull();
  });
});
