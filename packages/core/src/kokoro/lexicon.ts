/**
 * The Kokoro pronunciation lexicon, shared by desktop and mobile.
 *
 * Entries come from the pinned offline voice pack, whose `lexicon-*.txt` files
 * list a word followed by its phoneme symbols, space separated. Both hosts read
 * the same files, so a sentence is pronounced identically everywhere.
 *
 * A dictionary cannot hold every inflection, so a miss is retried through the
 * ordinary English suffix rules before the caller falls back to letter-to-sound.
 * That recovers regular plurals, possessives, past tenses and gerunds built on a
 * known stem, which is most of what a large word list is missing.
 *
 * Given its language, a lexicon also knows the words whose pronunciation
 * depends on how they are used ("present" the gift or the verb). The voice
 * pack flattened those to one reading each; `senses-data.ts` restores the rest.
 */

import { KOKORO_SENSES_GB, KOKORO_SENSES_US } from './senses-data.js';

/** The dictionary's accent: American voices are `a*`, British voices `b*`. */
export type KokoroLanguage = 'us' | 'gb';

/**
 * A use that changes how a word is said, named after misaki's tags: `VBD` and
 * `VBN` are the past tense and participle, and `FINAL` is the stressed form a
 * function word takes at the end of a phrase ("yes, we can").
 */
export type KokoroSense = 'NOUN' | 'VERB' | 'ADJ' | 'ADV' | 'VBD' | 'VBN' | 'FINAL';

type SenseVariants = Readonly<Partial<Record<KokoroSense | 'DEFAULT', string>>>;

/** Phonemes that count as a vowel nucleus, including Kokoro's diphthong letters. */
const VOWELS = new Set([...'AIWYOQaæɑɒɔəɛɜiɪuʊʌᵻ']);
/** Voiceless obstruents: they take the voiceless allomorph of -s and -ed. */
const VOICELESS = new Set([...'ptkfθsʃʧh']);
/** Sibilants: they force the syllabic allomorph of -s. */
const SIBILANTS = new Set([...'szʃʒʧʤ']);

function lastPhoneme(phonemes: string): string {
  const symbols = [...phonemes].filter((symbol) => symbol !== 'ˈ' && symbol !== 'ˌ');
  return symbols.at(-1) ?? '';
}

/** Whether a pronunciation opens with a vowel sound, ignoring stress marks. */
export function startsWithVowelSound(phonemes: string): boolean {
  for (const symbol of phonemes) {
    if (symbol === 'ˈ' || symbol === 'ˌ') continue;
    return VOWELS.has(symbol);
  }
  return false;
}

/** English -s: sibilant stems take a syllable, voiceless stems take /s/, others /z/. */
export function pluralSuffix(stem: string): string {
  const final = lastPhoneme(stem);
  if (SIBILANTS.has(final)) return 'ᵻz';
  return VOICELESS.has(final) ? 's' : 'z';
}

/** English -ed: alveolar stops take a syllable, voiceless stems take /t/, others /d/. */
function pastSuffix(stem: string): string {
  const final = lastPhoneme(stem);
  if (final === 't' || final === 'd') return 'ᵻd';
  return VOICELESS.has(final) ? 't' : 'd';
}

/** Spelling stems to try for an inflected form, most likely first. */
function stemCandidates(word: string, suffix: string): string[] {
  const base = word.slice(0, -suffix.length);
  if (!base) return [];
  const candidates = [base];
  // "making" drops the silent e; "carries" turns y into i; "running" doubles.
  candidates.push(`${base}e`);
  if (base.endsWith('i')) candidates.push(`${base.slice(0, -1)}y`);
  const final = base.at(-1) ?? '';
  if (base.length > 2 && final === base.at(-2) && !'aeiou'.includes(final))
    candidates.push(base.slice(0, -1));
  return candidates;
}

export interface KokoroLexicon {
  /** Number of dictionary entries. */
  readonly size: number;
  /** Phonemes for a word, or undefined when neither it nor a known stem matches. */
  lookup(word: string): string | undefined;
  /** Phonemes for a word the dictionary lists itself, without rebuilding inflections. */
  lookupEntry?(word: string): string | undefined;
  /**
   * Phonemes for a word whose pronunciation depends on its use: the reading for
   * the first of `senses` it has, else its default. Undefined when the word
   * reads the same in every use, or the lexicon was parsed without a language.
   */
  lookupSense?(word: string, senses: readonly KokoroSense[]): string | undefined;
}

export interface KokoroLexiconOptions {
  /** The dictionary's accent; enables readings that depend on a word's use. */
  readonly language?: KokoroLanguage;
}

const senseTables = new Map<KokoroLanguage, ReadonlyMap<string, SenseVariants>>();

/** One word per line, then `SENSE=phonemes` pairs. Parsed once per language. */
function senseTable(language: KokoroLanguage): ReadonlyMap<string, SenseVariants> {
  const cached = senseTables.get(language);
  if (cached) return cached;
  const table = new Map<string, SenseVariants>();
  for (const line of (language === 'gb' ? KOKORO_SENSES_GB : KOKORO_SENSES_US).split('\n')) {
    const [word, ...pairs] = line.split(' ');
    if (!word || !pairs.length) continue;
    const variants: Partial<Record<KokoroSense | 'DEFAULT', string>> = {};
    for (const pair of pairs) {
      const equals = pair.indexOf('=');
      variants[pair.slice(0, equals) as KokoroSense | 'DEFAULT'] = pair.slice(equals + 1);
    }
    table.set(word, variants);
  }
  senseTables.set(language, table);
  return table;
}

/**
 * Parse a voice-pack lexicon file. Lines are `word sym sym sym`; symbols are
 * joined into one phoneme string. Later duplicates lose, matching the order the
 * pack itself resolves them in.
 */
export function parseKokoroLexicon(
  text: string,
  options: KokoroLexiconOptions = {},
): KokoroLexicon {
  const entries = new Map<string, string>();
  for (const line of text.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space <= 0) continue;
    const word = line.slice(0, space).toLowerCase();
    const phonemes = line
      .slice(space + 1)
      .split(' ')
      .join('');
    if (!phonemes || entries.has(word)) continue;
    entries.set(word, phonemes);
  }
  return new MapLexicon(entries, options.language ? senseTable(options.language) : undefined);
}

class MapLexicon implements KokoroLexicon {
  private readonly entries: ReadonlyMap<string, string>;
  private readonly senses: ReadonlyMap<string, SenseVariants> | undefined;

  constructor(
    entries: ReadonlyMap<string, string>,
    senses: ReadonlyMap<string, SenseVariants> | undefined,
  ) {
    this.entries = entries;
    this.senses = senses;
  }

  get size(): number {
    return this.entries.size;
  }

  lookup(word: string): string | undefined {
    const key = word.toLowerCase();
    const direct = this.entries.get(key);
    if (direct !== undefined) return direct;
    return this.inflected(key);
  }

  lookupEntry(word: string): string | undefined {
    return this.entries.get(word.toLowerCase());
  }

  lookupSense(word: string, senses: readonly KokoroSense[]): string | undefined {
    const key = word.toLowerCase();
    const variants = this.senses?.get(key);
    if (!variants) return undefined;
    for (const sense of senses) {
      const reading = variants[sense];
      if (reading !== undefined) return reading;
    }
    return variants.DEFAULT ?? this.entries.get(key);
  }

  /** Rebuild a regular inflection from a stem the dictionary does know. */
  private inflected(word: string): string | undefined {
    // Possessives and contractions of "is"/"has" are pronounced like a plural.
    const apostrophe = /^(.+?)['’]s$/.exec(word);
    if (apostrophe) {
      const stem = this.entries.get(apostrophe[1]!);
      if (stem) return stem + pluralSuffix(stem);
    }
    if (word.endsWith("s'") || word.endsWith('s’')) {
      const stem = this.entries.get(word.slice(0, -1));
      if (stem) return stem;
    }
    for (const [suffix, build] of [
      ['ing', (stem: string) => `${stem}ɪŋ`],
      ['ed', (stem: string) => stem + pastSuffix(stem)],
      ['es', (stem: string) => stem + pluralSuffix(stem)],
      ['s', (stem: string) => stem + pluralSuffix(stem)],
    ] as const) {
      if (!word.endsWith(suffix)) continue;
      for (const candidate of stemCandidates(word, suffix)) {
        const stem = this.entries.get(candidate);
        if (stem) return build(stem);
      }
    }
    // Compounds and hyphenated coinages resolve part by part.
    if (word.includes('-')) {
      const parts = word.split('-').filter(Boolean);
      if (parts.length > 1) {
        const resolved = parts.map((part) => this.lookup(part));
        if (resolved.every((part): part is string => part !== undefined)) return resolved.join('');
      }
    }
    return undefined;
  }
}
