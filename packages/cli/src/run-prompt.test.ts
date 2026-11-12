import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { detectStdinKind, resolveRunPrompt } from './run-prompt.js';

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

  it('adds a redirected file after the prompt, separated by a blank line', async () => {
    await expect(
      resolveRunPrompt(['Use', 'the text I piped in'], Readable.from(['The launch is Friday.\n']), {
        stdinKind: 'file',
      }),
    ).resolves.toBe('Use the text I piped in\n\nThe launch is Friday.\n');
  });

  it('adds what a pipe delivers, read to its end', async () => {
    const chunks = ['first ', 'and ', 'last'].map((text) => Buffer.from(text));
    await expect(
      resolveRunPrompt(['Summarize'], Readable.from(chunks), { stdinKind: 'pipe' }),
    ).resolves.toBe('Summarize\n\nfirst and last');
  });

  it.each(['', ' \r\n\t '])(
    'sends the prompt alone when the pipe ends empty (%j)',
    async (text) => {
      await expect(
        resolveRunPrompt(['Summarize'], Readable.from([text]), { stdinKind: 'pipe' }),
      ).resolves.toBe('Summarize');
    },
  );

  it('goes on without a pipe that stays silent, and lets go of it', async () => {
    const silent = new PassThrough();
    const started = Date.now();
    await expect(
      resolveRunPrompt(['Summarize'], silent, { stdinKind: 'pipe', firstDataMs: 20 }),
    ).resolves.toBe('Summarize');
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(silent.isPaused()).toBe(true);
  });

  it.each(['tty', 'none'] as const)(
    'never reads stdin of kind %s beside a prompt',
    async (kind) => {
      const input = unreadInput(kind === 'tty');
      await expect(resolveRunPrompt(['Summarize'], input, { stdinKind: kind })).resolves.toBe(
        'Summarize',
      );
      expect(input[Symbol.asyncIterator]).not.toHaveBeenCalled();
    },
  );

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

describe('detectStdinKind', () => {
  const mode = (bits: number) => () => ({ mode: bits });

  it('reads the mode bits, which also mark a pipe on Windows', () => {
    expect(detectStdinKind(mode(0o100644), undefined)).toBe('file');
    expect(detectStdinKind(mode(0o010000), undefined)).toBe('pipe');
    expect(detectStdinKind(mode(0o140777), undefined)).toBe('pipe');
  });

  it('leaves a terminal, a null device and a missing stdin unread', () => {
    expect(detectStdinKind(mode(0o020620), true)).toBe('tty');
    expect(detectStdinKind(mode(0o020666), undefined)).toBe('none');
    expect(
      detectStdinKind(() => {
        throw new Error('EBADF');
      }, undefined),
    ).toBe('none');
  });
});
