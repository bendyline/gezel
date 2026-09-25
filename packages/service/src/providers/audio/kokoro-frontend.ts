/**
 * The desktop half of Kokoro's text frontend.
 *
 * Kokoro reads phoneme ids rather than text. `kokoro-js` will do that
 * conversion itself, but only by calling `phonemizer`, which embeds eSpeak NG —
 * GPL-3 code that cannot ship inside an MIT app on the app stores. So the
 * daemon converts text here instead, using the shared `@bendyline/gezel/kokoro`
 * frontend and the same dictionary the mobile voice pack carries, and hands
 * `generate_from_ids` the token ids directly.
 *
 * The dictionaries are staged by `scripts/build-kokoro-lexicon.mjs` and
 * gzipped; they are read once, on first synthesis, and then cached.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import {
  type KokoroLexicon,
  parseKokoroLexicon,
  phonemizeForKokoro,
  splitForKokoro,
  tokenizeKokoroPhonemes,
} from '@bendyline/gezel/kokoro';

/** Kokoro voice ids start with their language: `af_heart` is American, `bm_george` British. */
export type KokoroLanguage = 'us' | 'gb';

/** One inference: a phrase short enough for the model, with its token ids. */
export interface KokoroUtterance {
  /** Source text, used only for progress reporting. */
  readonly text: string;
  /** Phonemes handed to the tokenizer, kept for diagnostics. */
  readonly phonemes: string;
  /** Padded token ids for `generate_from_ids`. */
  readonly tokens: readonly number[];
}

/** American voices are `a*`, British voices are `b*`; anything else reads as American. */
export function kokoroLanguageForVoice(voiceId: string): KokoroLanguage {
  return voiceId.startsWith('b') ? 'gb' : 'us';
}

const FILES: Readonly<Record<KokoroLanguage, string>> = {
  us: 'lexicon-us-en.txt.gz',
  gb: 'lexicon-gb-en.txt.gz',
};

/**
 * Find the staged dictionaries. `dist/kokoro-lexicon` is the packaged copy;
 * the repo path is the development fallback, mirroring how the UI bundle and
 * the handboek content are located.
 */
export function findKokoroLexiconDir(from = import.meta.url): string | undefined {
  // Walk up rather than assume a depth: the bundled layout under dist/ and the
  // source layout under src/ nest differently, and both must resolve.
  let directory = dirname(fileURLToPath(from));
  for (let depth = 0; depth < 6; depth++) {
    for (const candidate of [
      join(directory, 'kokoro-lexicon'),
      join(directory, 'assets', 'kokoro'),
    ])
      if (existsSync(join(candidate, FILES.us))) return candidate;
    const parent = resolve(directory, '..');
    if (parent === directory) break;
    directory = parent;
  }
  return undefined;
}

export interface KokoroFrontendOptions {
  /** Directory holding the gzipped dictionaries. Defaults to the staged copy. */
  readonly lexiconDir?: string;
}

/** Loads and caches the dictionaries, and turns text into model-ready utterances. */
export class KokoroFrontend {
  private readonly lexiconDir: string | undefined;
  private readonly loaded = new Map<KokoroLanguage, Promise<KokoroLexicon>>();

  constructor(options: KokoroFrontendOptions = {}) {
    this.lexiconDir = options.lexiconDir ?? findKokoroLexiconDir();
  }

  /** Read one dictionary, at most once per process. */
  private lexicon(language: KokoroLanguage): Promise<KokoroLexicon> {
    const cached = this.loaded.get(language);
    if (cached) return cached;
    const directory = this.lexiconDir;
    const pending = (async () => {
      if (!directory)
        throw new Error(
          'Kokoro pronunciation dictionary is missing; rebuild the service ' +
            '(node scripts/build-kokoro-lexicon.mjs stages it).',
        );
      const file = join(directory, FILES[language]);
      let packed: Buffer;
      try {
        packed = await readFile(file);
      } catch (cause) {
        // A bare ENOENT here reads as a bug; say what is missing and how to
        // put it back, because a packaging slip is the likely cause.
        throw new Error(
          `Kokoro pronunciation dictionary is missing at ${file}; rebuild the service (node scripts/build-kokoro-lexicon.mjs stages it).`,
          { cause },
        );
      }
      return parseKokoroLexicon(gunzipSync(packed).toString('utf8'));
    })();
    // A failed read must not be cached as a permanent failure.
    void pending.catch(() => this.loaded.delete(language));
    this.loaded.set(language, pending);
    return pending;
  }

  /**
   * Break text into utterances the model can speak, each already tokenized.
   * Sentences stay whole where they fit, so the caller keeps streaming one
   * sentence of audio at a time.
   */
  async plan(text: string, voiceId: string): Promise<KokoroUtterance[]> {
    const lexicon = await this.lexicon(kokoroLanguageForVoice(voiceId));
    const utterances: KokoroUtterance[] = [];
    // Split the source text first so progress still tracks readable units.
    const sentences = text
      .split(/(?<=[.!?…])\s+/)
      .map((sentence) => sentence.trim())
      .filter(Boolean);
    for (const sentence of sentences.length ? sentences : [text.trim()].filter(Boolean)) {
      const phonemes = phonemizeForKokoro(sentence, { lexicon });
      if (!phonemes) continue;
      // A single very long sentence still has to fit the model's style table.
      for (const piece of splitForKokoro(phonemes)) {
        const { tokens } = tokenizeKokoroPhonemes(piece);
        // Two pad frames and nothing else would be silence.
        if (tokens.length <= 2) continue;
        utterances.push({ text: sentence, phonemes: piece, tokens });
      }
    }
    return utterances;
  }
}
