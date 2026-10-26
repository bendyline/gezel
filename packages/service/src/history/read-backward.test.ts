import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readLinesBackward } from './read-backward.js';

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
