import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { resolveRunPrompt } from './run-prompt.js';

function unreadInput(isTTY = false) {
  return {
    isTTY,
    [Symbol.asyncIterator]: vi.fn(() => {
      throw new Error('Unexpected stdin read');
    }),
  };
}

describe('resolveRunPrompt', () => {
  it('joins and trims arguments without consuming stdin', async () => {
    const input = unreadInput();
    await expect(resolveRunPrompt(['  Explain', '-', 'this  '], input)).resolves.toBe(
      'Explain - this',
    );
    expect(input[Symbol.asyncIterator]).not.toHaveBeenCalled();
  });

  it('requires an explicit dash to consume stdin', async () => {
    const input = unreadInput();
    await expect(resolveRunPrompt([], input)).rejects.toThrow('usage: gezel run');
    expect(input[Symbol.asyncIterator]).not.toHaveBeenCalled();
  });

  it('preserves multiline text, indentation, and split UTF-8 characters', async () => {
    const prompt = '  Summarize:\n    café\r\n';
    const chunks = Array.from(Buffer.from(prompt), (byte) => Buffer.from([byte]));
    await expect(resolveRunPrompt(['-'], Readable.from(chunks))).resolves.toBe(prompt);
  });

  it('accepts a stream that already decodes text', async () => {
    await expect(resolveRunPrompt(['-'], Readable.from(['Hello', '\nworld']))).resolves.toBe(
      'Hello\nworld',
    );
  });

  it.each(['', ' \r\n\t '])('rejects empty or whitespace-only stdin (%j)', async (prompt) => {
    await expect(resolveRunPrompt(['-'], Readable.from([prompt]))).rejects.toMatchObject({
      name: 'CliError',
      message: expect.stringContaining('empty input'),
    });
  });

  it('rejects a terminal without waiting for input', async () => {
    const input = unreadInput(true);
    await expect(resolveRunPrompt(['-'], input)).rejects.toThrow('requires piped input');
    expect(input[Symbol.asyncIterator]).not.toHaveBeenCalled();
  });

  it('reports an unreadable stream as a CLI error', async () => {
    const input = Readable.from(
      (async function* () {
        yield 'partial prompt';
        throw new Error('stream failed');
      })(),
    );
    await expect(resolveRunPrompt(['-'], input)).rejects.toMatchObject({
      name: 'CliError',
      message: 'Could not read prompt from stdin: stream failed',
    });
  });
});
