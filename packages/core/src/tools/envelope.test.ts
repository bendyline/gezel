import { describe, expect, it } from 'vitest';
import { parseToolEnvelopeReply } from './envelope.js';

describe('whole-reply tool envelopes', () => {
  it('closes the call a small model left open at the end', () => {
    // Verbatim from Qwen 3.5 2B on a Galaxy S20 FE (2026-09-26).
    const reply =
      '```json\n{\n"name": "write_file",\n"arguments": {\n"path": "result.json",\n"content": "{\\n  \\"total\\": 28,\\n  \\"largestName\\": \\"Ada\\",\\n  \\"rowCount\\": 3\\n}"\n}\n```';
    expect(parseToolEnvelopeReply(reply)).toEqual({
      name: 'write_file',
      arguments: {
        path: 'result.json',
        content: '{\n  "total": 28,\n  "largestName": "Ada",\n  "rowCount": 3\n}',
      },
    });
    expect(
      parseToolEnvelopeReply('{"name":"write_file","arguments":{"path":"a.md","content":"{{"'),
    ).toEqual({ name: 'write_file', arguments: { path: 'a.md', content: '{{' } });
  });

  it('repairs nothing that is not plainly one unclosed call', () => {
    for (const reply of [
      '{"name":"write_file","arguments":{"path":"a.md","content":{"x":{"y":1',
      '{"name":"write_file","arguments":{"path":"a.md","content":"open',
      '{"name":"write_file","arguments":{"path":"a.md"]',
      'Here it is: {"name":"write_file","arguments":{"path":"a.md","content":"x"}',
      'Example:\n```json\n{"name":"write_file","arguments":{"path":"a.md","content":"x"}\n```',
      '{"name":"write_file","arguments":{"path":"a.md","content":"x"},"extra":1',
    ])
      expect(parseToolEnvelopeReply(reply)).toBeNull();
  });
});
