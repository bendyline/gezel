import { type KokoroPhonemizeOptions, phonemizeForKokoroWithMapping } from './phonemize.js';
import type { KokoroSourceRange } from './source-map.js';
import { KOKORO_MAX_PHONEMES, KOKORO_PAD_TOKEN, kokoroTokenFor } from './vocab.js';

export interface KokoroWordTokens extends KokoroSourceRange {
  /** Half-open indices into the padded token array, including its leading pad. */
  readonly tokenStart: number;
  readonly tokenEnd: number;
}

export interface KokoroPlannedUtterance extends KokoroSourceRange {
  readonly phonemes: string;
  readonly tokens: readonly number[];
  readonly words: readonly KokoroWordTokens[];
}

/** Keeps source ranges through normalization, token filtering and model-sized splits. */
export function planKokoroSpeech(
  text: string,
  options: KokoroPhonemizeOptions,
): KokoroPlannedUtterance[] {
  const mapped = phonemizeForKokoroWithMapping(text, options);
  const symbols: Array<KokoroSourceRange & { symbol: string; token: number; word?: number }> = [];
  let offset = 0;
  for (const symbol of mapped.phonemes) {
    const range = mapped.ranges[offset]!;
    const token = kokoroTokenFor(symbol);
    if (token !== undefined) symbols.push({ ...range, symbol, token });
    offset += symbol.length;
  }
  const chunks: KokoroPlannedUtterance[] = [];
  let start = 0;
  while (start < symbols.length) {
    while (symbols[start]?.symbol === ' ') start++;
    if (start === symbols.length) break;
    let end = Math.min(start + KOKORO_MAX_PHONEMES, symbols.length);
    if (end < symbols.length) {
      let space = end;
      while (space > start && symbols[space]?.symbol !== ' ') space--;
      if (space > start) end = space;
    }
    while (end > start && symbols[end - 1]!.symbol === ' ') end--;
    const piece = symbols.slice(start, end);
    const words: KokoroWordTokens[] = [];
    for (let i = 0; i < piece.length; ) {
      const first = piece[i]!;
      if (first.word === undefined) {
        i++;
        continue;
      }
      let next = i + 1;
      while (next < piece.length && piece[next]!.word === first.word) next++;
      words.push({
        textStart: first.textStart,
        textEnd: first.textEnd,
        tokenStart: i + 1,
        tokenEnd: next + 1,
      });
      i = next;
    }
    chunks.push({
      textStart: piece[0]!.textStart,
      textEnd: piece.at(-1)!.textEnd,
      phonemes: piece.map(({ symbol }) => symbol).join(''),
      tokens: [KOKORO_PAD_TOKEN, ...piece.map(({ token }) => token), KOKORO_PAD_TOKEN],
      words,
    });
    start = end;
  }
  return chunks;
}
