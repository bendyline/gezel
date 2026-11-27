import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readLinesBackward, readMatchingLinesBackward } from './read-backward.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gezel-read-backward-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function linesOf(content: string | Buffer, chunkBytes?: number): Promise<string[]> {
  const path = join(dir, 'file.jsonl');
  await writeFile(path, content);
  const out: string[] = [];
  for await (const line of readLinesBackward(path, chunkBytes)) out.push(line);
  return out;
}

describe('readLinesBackward', () => {
  it('returns lines last-first, whatever the chunk size', async () => {
    const content = 'alpha\nbravo\ncharlie\ndelta\n';
    for (const chunk of [1, 2, 3, 5, 7, 64]) {
      expect(await linesOf(content, chunk)).toEqual(['delta', 'charlie', 'bravo', 'alpha']);
    }
  });

  it('keeps multibyte characters whole across chunk boundaries', async () => {
    const lines = ['café ☕', '日本語のテキスト', 'emoji 🧭 here'];
    for (const chunk of [1, 2, 3, 4, 5]) {
      expect(await linesOf(`${lines.join('\n')}\n`, chunk)).toEqual([...lines].reverse());
    }
  });

  it('returns a last line with no trailing newline, and skips empty lines', async () => {
    expect(await linesOf('one\n\n\ntwo\nthree', 4)).toEqual(['three', 'two', 'one']);
  });

  it('leaves the carriage return of a CRLF line for the parser to ignore', async () => {
    const lines = await linesOf('{"a":1}\r\n{"a":2}\r\n', 3);
    expect(lines.map((line) => JSON.parse(line).a)).toEqual([2, 1]);
  });

  it('yields nothing for an empty file', async () => {
    expect(await linesOf('')).toEqual([]);
  });

  it('rejects with ENOENT for a missing file', async () => {
    const lines = readLinesBackward(join(dir, 'missing.jsonl'));
    await expect(lines.next()).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('readMatchingLinesBackward', () => {
  async function matching(
    content: string,
    text: string,
    chunkBytes?: number,
    isPast?: (lineStart: string) => boolean,
  ): Promise<string[]> {
    const path = join(dir, 'file.jsonl');
    await writeFile(path, content);
    const out: string[] = [];
    for await (const line of readMatchingLinesBackward(path, text, isPast, chunkBytes)) {
      out.push(line);
    }
    return out;
  }

  it('returns only the lines that hold the text, last-first, whatever the chunk size', async () => {
    const content = 'ref-1 a\nref-2 b\n\nref-1 c ref-1 c\nref-10 d\nnone\nref-1 e\n';
    for (const chunk of [1, 2, 3, 5, 7, 11, 64]) {
      expect(await matching(content, 'ref-1 ', chunk)).toEqual([
        'ref-1 e',
        'ref-1 c ref-1 c', // two matches, one line
        'ref-1 a',
      ]);
    }
  });

  it('returns exactly what decoding every line and filtering would', async () => {
    // A small fixed generator: the same files every run.
    let seed = 7;
    const next = (below: number) => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return (seed >>> 16) % below;
    };
    let found = 0;
    const alphabet = ['x', 'ref', '-', '"', '1', '☕', '日本', ' ', 'r', 're'];
    for (let round = 0; round < 30; round++) {
      const lines = Array.from({ length: next(10) }, () =>
        Array.from({ length: next(8) }, () => alphabet[next(alphabet.length)]).join(''),
      );
      const content = lines.join('\n') + (next(2) ? '\n' : '');
      const expected = lines.filter((line) => line.includes('ref')).reverse();
      found += expected.length;
      for (const chunk of [1, 3, 9, 1000]) {
        expect(await matching(content, 'ref', chunk)).toEqual(expected);
      }
    }
    expect(found).toBeGreaterThan(15);
  });

  it('finds a match in a line far longer than the chunk', async () => {
    const long = `${'a'.repeat(5000)}needle${'b'.repeat(5000)}`;
    expect(await matching(`one\n${long}\nneedle two\n`, 'needle', 64)).toEqual([
      'needle two',
      long,
    ]);
  });

  it('stops at its bound without a match, and yields nothing from an older chunk', async () => {
    const lines = Array.from(
      { length: 1000 },
      (_, i) => `${String(i).padStart(4, '0')} ${i === 10 ? 'needle' : 'other'}`,
    );
    const seen: number[] = [];
    const past = (lineStart: string) => {
      seen.push(Number(lineStart.slice(0, 4)));
      return Number(lineStart.slice(0, 4)) < 950;
    };
    expect(await matching(`${lines.join('\n')}\n`, 'needle', 110, past)).toEqual([]);
    // Ten lines to a chunk: it looked at the newest five and a bit, then stopped.
    expect(seen.length).toBeLessThanOrEqual(7);
    expect(Math.min(...seen)).toBeGreaterThan(900);
    expect(await matching(`${lines.join('\n')}\n`, 'needle', 110)).toEqual(['0010 needle']);
  });

  it('refuses text that cannot be within one line', async () => {
    await expect(matching('a\n', '')).rejects.toThrow('within one line');
    await expect(matching('a\n', 'a\nb')).rejects.toThrow('within one line');
  });

  it('rejects with ENOENT for a missing file', async () => {
    const lines = readMatchingLinesBackward(join(dir, 'missing.jsonl'), 'needle');
    await expect(lines.next()).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
