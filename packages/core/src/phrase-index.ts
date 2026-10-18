/**
 * Phrases matched against what a person typed: craftbook triggers ("meeting
 * minutes", "draft a social post"), and anything else that offers itself on a
 * named phrase. Text is normalized once — lowercase, straight apostrophes,
 * single spaces — and a phrase matches only on word boundaries: the characters
 * on either side are not letters or digits, so "changelog" cannot fire from
 * "change logging". Phrases are bucketed by their first word, so a lookup
 * costs the words in the text, not the size of the vocabulary.
 */

const WORDS = /[\p{L}\p{N}]+/gu;
const LEADING_WORD = /^[\p{L}\p{N}]+/u;
const WORD_CHAR_AT_START = /^[\p{L}\p{N}]/u;
const WORD_CHAR_AT_END = /[\p{L}\p{N}]$/u;

export function normalizePhraseText(text: string): string {
  return text.toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();
}

export interface PhraseEntry<T> {
  phrase: string;
  value: T;
}

export interface PhraseHit<T> {
  value: T;
  /** The phrase as it was added, before normalization. */
  phrase: string;
}

export interface PhraseIndexOptions {
  /** Normalized phrases shorter than this never match. */
  minLength?: number;
}

interface IndexedPhrase<T> {
  normalized: string;
  phrase: string;
  value: T;
  order: number;
}

// Two code units cover an astral letter on either side of the boundary.
function wordCharBefore(text: string, at: number): boolean {
  return at > 0 && WORD_CHAR_AT_END.test(text.slice(Math.max(0, at - 2), at));
}

function wordCharAfter(text: string, at: number): boolean {
  return WORD_CHAR_AT_START.test(text.slice(at, at + 2));
}

export class PhraseIndex<T> {
  private readonly byFirstWord = new Map<string, IndexedPhrase<T>[]>();
  /** Phrases opening on punctuation (".net"), which no word lookup reaches. */
  private readonly unanchored: IndexedPhrase<T>[] = [];

  constructor(entries: Iterable<PhraseEntry<T>>, opts: PhraseIndexOptions = {}) {
    const minLength = Math.max(1, opts.minLength ?? 1);
    let order = 0;
    for (const { phrase, value } of entries) {
      const normalized = normalizePhraseText(phrase);
      if (normalized.length < minLength) continue;
      const indexed = { normalized, phrase, value, order: order++ };
      const first = LEADING_WORD.exec(normalized)?.[0];
      if (!first) {
        this.unanchored.push(indexed);
        continue;
      }
      const bucket = this.byFirstWord.get(first);
      if (bucket) bucket.push(indexed);
      else this.byFirstWord.set(first, [indexed]);
    }
  }

  /** Every phrase the text contains, each once, in the order they were added. */
  matches(text: string): PhraseHit<T>[] {
    return this.found(text).map(({ phrase, value }) => ({ phrase, value }));
  }

  /** The longest phrase the text contains; a tie goes to the phrase added first. */
  longest(text: string): PhraseHit<T> | null {
    let best: IndexedPhrase<T> | null = null;
    for (const hit of this.found(text)) {
      if (!best || hit.normalized.length > best.normalized.length) best = hit;
    }
    return best ? { phrase: best.phrase, value: best.value } : null;
  }

  private found(text: string): IndexedPhrase<T>[] {
    const haystack = normalizePhraseText(text);
    if (!haystack) return [];
    const hits = new Set<IndexedPhrase<T>>();
    // A word run is maximal, so its start is already a left boundary.
    for (const word of haystack.matchAll(WORDS)) {
      const bucket = this.byFirstWord.get(word[0]);
      if (!bucket) continue;
      for (const indexed of bucket) {
        if (hits.has(indexed) || !haystack.startsWith(indexed.normalized, word.index)) continue;
        if (!wordCharAfter(haystack, word.index + indexed.normalized.length)) hits.add(indexed);
      }
    }
    for (const indexed of this.unanchored) {
      for (let at = haystack.indexOf(indexed.normalized); at >= 0; ) {
        if (
          !wordCharBefore(haystack, at) &&
          !wordCharAfter(haystack, at + indexed.normalized.length)
        ) {
          hits.add(indexed);
          break;
        }
        at = haystack.indexOf(indexed.normalized, at + 1);
      }
    }
    return [...hits].sort((a, b) => a.order - b.order);
  }
}
