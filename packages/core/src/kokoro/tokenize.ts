/**
 * Phonemes to Kokoro token ids.
 *
 * The model reads a padded run of phoneme ids. Anything it has no symbol for is
 * dropped rather than guessed, and the run is truncated to the longest length
 * the voice pack carries a style vector for.
 */

import { KOKORO_MAX_PHONEMES, KOKORO_PAD_TOKEN, kokoroTokenFor } from './vocab.js';

export interface KokoroTokens {
  /** Padded token ids, ready for the model. */
  readonly tokens: readonly number[];
  /** Phoneme count excluding padding; selects the voice's style vector. */
  readonly phonemeCount: number;
  /** True when the phrase was longer than the model accepts. */
  readonly truncated: boolean;
}

/** Encode a phoneme string, padded the way Kokoro expects. */
export function tokenizeKokoroPhonemes(phonemes: string): KokoroTokens {
  const ids: number[] = [];
  let dropped = false;
  for (const symbol of phonemes) {
    const id = kokoroTokenFor(symbol);
    if (id === undefined) continue;
    if (ids.length >= KOKORO_MAX_PHONEMES) {
      dropped = true;
      break;
    }
    ids.push(id);
  }
  return {
    tokens: [KOKORO_PAD_TOKEN, ...ids, KOKORO_PAD_TOKEN],
    phonemeCount: ids.length,
    truncated: dropped,
  };
}

/**
 * Split text into pieces that each fit the model, breaking at sentence ends and
 * then at spaces. Callers synthesize each piece and concatenate the audio.
 */
export function splitForKokoro(phonemes: string, limit = KOKORO_MAX_PHONEMES): string[] {
  if ([...phonemes].length <= limit) return phonemes ? [phonemes] : [];
  const pieces: string[] = [];
  let current = '';
  const flush = () => {
    const trimmed = current.trim();
    if (trimmed) pieces.push(trimmed);
    current = '';
  };
  // Sentence-final punctuation the model knows, longest phrase first.
  for (const sentence of phonemes.split(/(?<=[.!?;:…])\s+/)) {
    if ([...sentence].length > limit) {
      flush();
      let chunk = '';
      for (const word of sentence.split(' ')) {
        if ([...chunk].length + [...word].length + 1 > limit) {
          if (chunk) pieces.push(chunk.trim());
          chunk = word.slice(0, limit);
        } else chunk = chunk ? `${chunk} ${word}` : word;
      }
      if (chunk.trim()) pieces.push(chunk.trim());
      continue;
    }
    if ([...current].length + [...sentence].length + 1 > limit) flush();
    current = current ? `${current} ${sentence}` : sentence;
  }
  flush();
  return pieces;
}
