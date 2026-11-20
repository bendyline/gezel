import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { chunkContentHash } from './node/ids.js';
import { sha256Hex } from './sha256.js';

const nodeHex = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');

describe('sha256', () => {
  it('matches node:crypto across block boundaries', () => {
    for (const length of [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000, 70_000]) {
      const text = 'a'.repeat(length);
      expect(sha256Hex(text), `length ${length}`).toBe(nodeHex(text));
    }
  });

  it('hashes strings as UTF-8, astral characters included', () => {
    for (const text of ['Café 🏔️ — naïve', '日本語のテキスト', '\u0000￿', 'emoji 👩‍👩‍👧‍👦 family']) {
      expect(sha256Hex(text)).toBe(nodeHex(text));
    }
  });

  it('hashes bytes as given', () => {
    const bytes = new Uint8Array(300).map((_, index) => (index * 37) & 0xff);
    expect(sha256Hex(bytes)).toBe(nodeHex(bytes));
  });

  it('agrees with the Node-only chunk content hash', () => {
    expect(sha256Hex('# Heading\n\nSome chunk text.')).toBe(
      chunkContentHash('# Heading\n\nSome chunk text.'),
    );
  });

  it('known vector: "abc"', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});
