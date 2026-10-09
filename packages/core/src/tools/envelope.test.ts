import { describe, expect, it } from 'vitest';
import { parseToolEnvelopeReply, trailingToolCallStart, withoutToolCallText } from './envelope.js';

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

  it('drops keys a small model sent with no value', () => {
    // Verbatim from Gemini Nano on a Galaxy S26+ (2026-10-02).
    const reply =
      '{"name":"ask_user_question","arguments":{"question":"Could you please tell me more about the project\'s goal?","prompt":"Please provide a brief description of the project\'s objective.","description":"Understanding the project\'s goal is crucial.","choices":[],"allowWriteIn","multiSelect","taskRef":"default","documentPath":""}}';
    expect(parseToolEnvelopeReply(reply)).toEqual({
      name: 'ask_user_question',
      arguments: {
        question: "Could you please tell me more about the project's goal?",
        prompt: "Please provide a brief description of the project's objective.",
        description: "Understanding the project's goal is crucial.",
        choices: [],
        taskRef: 'default',
        documentPath: '',
      },
    });
    expect(
      parseToolEnvelopeReply(
        '{"name":"ask_user_question","arguments":{"question":"Which?","choices":["a","b"],"multiSelect"}}',
      ),
    ).toEqual({
      name: 'ask_user_question',
      arguments: { question: 'Which?', choices: ['a', 'b'] },
    });
    expect(
      parseToolEnvelopeReply('Try this: {"name":"read_file","arguments":{"path":"a.md","x"}}'),
    ).toBeNull();
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

describe('calls a small model writes around its prose', () => {
  const escaped =
    '{\\"name\\":\\"make_move\\",\\"arguments\\":{\\"from\\":\\"d6\\",\\"to\\":\\"c5\\",\\"moveThought\\":\\"A little shift!\\"}}';

  it('reads a whole reply whose quotes are escaped one level too many', () => {
    expect(parseToolEnvelopeReply(escaped)).toEqual({
      name: 'make_move',
      arguments: { from: 'd6', to: 'c5', moveThought: 'A little shift!' },
    });
  });

  it('finds a call after prose without ever treating it as the reply', () => {
    const reply = `Alright, a bold move!\n\n${escaped}`;
    expect(parseToolEnvelopeReply(reply)).toBeNull();
    expect(trailingToolCallStart(reply)).toBe(reply.indexOf('{'));
    expect(withoutToolCallText(reply)).toBe('Alright, a bold move!');
    expect(withoutToolCallText(escaped)).toBe('');
  });

  it('leaves JSON that is not a call alone', () => {
    const json = '{"name": "Alice", "age": 3}';
    expect(withoutToolCallText(json)).toBe(json);
    expect(withoutToolCallText(`Here it is:\n${json}`)).toBe(`Here it is:\n${json}`);
    expect(trailingToolCallStart('Just text.')).toBe(-1);
  });
});
