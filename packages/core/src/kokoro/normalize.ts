/**
 * Turn ordinary written text into the words a reader would say.
 *
 * Kokoro is given phonemes, and the lexicon only holds words, so digits,
 * currency and symbols have to become words first. This is the small,
 * dependency-free replacement for the normalisation the previous text-to-speech
 * frontend inherited from its phonemizer.
 */

const ONES = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const SCALES: readonly (readonly [number, string])[] = [
  [1_000_000_000_000, 'trillion'],
  [1_000_000_000, 'billion'],
  [1_000_000, 'million'],
  [1_000, 'thousand'],
  [100, 'hundred'],
];
const ORDINALS: Readonly<Record<string, string>> = {
  one: 'first',
  two: 'second',
  three: 'third',
  five: 'fifth',
  eight: 'eighth',
  nine: 'ninth',
  twelve: 'twelfth',
};
const SYMBOLS: Readonly<Record<string, string>> = {
  '&': ' and ',
  '@': ' at ',
  '%': ' percent ',
  '=': ' equals ',
  '+': ' plus ',
  '°': ' degrees ',
  '©': ' copyright ',
  '®': ' registered ',
  '™': ' trademark ',
};
const CURRENCIES: Readonly<Record<string, readonly [string, string]>> = {
  $: ['dollar', 'cent'],
  '£': ['pound', 'pence'],
  '€': ['euro', 'cent'],
  '¥': ['yen', 'sen'],
};
/** Titles a reader expands rather than spells. */
const ABBREVIATIONS: Readonly<Record<string, string>> = {
  mr: 'mister',
  mrs: 'missus',
  ms: 'miss',
  dr: 'doctor',
  prof: 'professor',
  st: 'saint',
  mt: 'mount',
  vs: 'versus',
  etc: 'et cetera',
  no: 'number',
};

/** Spell a non-negative integer below one thousand. */
function underThousand(value: number): string {
  if (value < 20) return ONES[value]!;
  if (value < 100) {
    const tens = TENS[Math.floor(value / 10)]!;
    const rest = value % 10;
    return rest ? `${tens} ${ONES[rest]!}` : tens;
  }
  const rest = value % 100;
  const hundreds = `${ONES[Math.floor(value / 100)]!} hundred`;
  return rest ? `${hundreds} ${underThousand(rest)}` : hundreds;
}

/** Spell a whole number the way it is read aloud. */
export function spellNumber(value: number): string {
  if (!Number.isFinite(value)) return 'not a number';
  if (value < 0) return `minus ${spellNumber(-value)}`;
  const whole = Math.floor(value);
  if (whole < 100) return underThousand(whole);
  for (const [scale, name] of SCALES) {
    if (whole < scale) continue;
    const count = Math.floor(whole / scale);
    const rest = whole % scale;
    const head = `${spellNumber(count)} ${name}`;
    return rest ? `${head} ${spellNumber(rest)}` : head;
  }
  return underThousand(whole);
}

/** Spell an ordinal, as in a date or a ranking. */
export function spellOrdinal(value: number): string {
  const words = spellNumber(value).split(' ');
  const last = words.at(-1) ?? '';
  const ordinal = ORDINALS[last] ?? (last.endsWith('y') ? `${last.slice(0, -1)}ieth` : `${last}th`);
  return [...words.slice(0, -1), ordinal].join(' ');
}

/** Read a four-digit year in pairs, the way people say it. */
function spellYear(value: number): string {
  if (value < 1100 || value > 2099) return spellNumber(value);
  const high = Math.floor(value / 100);
  const low = value % 100;
  if (low === 0) return `${spellNumber(high)} hundred`;
  if (value >= 2000 && value < 2010) return spellNumber(value);
  return `${spellNumber(high)} ${low < 10 ? `oh ${spellNumber(low)}` : spellNumber(low)}`;
}

function spellDigits(digits: string): string {
  return [...digits].map((digit) => ONES[Number(digit)]!).join(' ');
}

/**
 * Rewrite text so every token is a word the lexicon can look up. Punctuation
 * the model understands is left in place; it carries the prosody.
 */
export function normalizeForSpeech(text: string): string {
  let output = text.normalize('NFC');
  // Currency reads as an amount and a unit: "$3.50" is three dollars fifty cents.
  output = output.replace(
    /([$£€¥])\s?(\d[\d,]*)(?:\.(\d{1,2}))?/g,
    (_match, symbol: string, whole: string, fraction?: string) => {
      const [major, minor] = CURRENCIES[symbol] ?? ['dollar', 'cent'];
      const amount = Number(whole.replace(/,/g, ''));
      const head = `${spellNumber(amount)} ${major}${amount === 1 ? '' : 's'}`;
      if (!fraction) return head;
      const cents = Number(fraction.padEnd(2, '0'));
      if (!cents) return head;
      return `${head} ${spellNumber(cents)} ${minor}${cents === 1 ? '' : 's'}`;
    },
  );
  output = output.replace(/(\d)(?:st|nd|rd|th)\b/gi, (_m, digit: string, offset: number) => {
    const start = /\d+$/.exec(output.slice(0, offset + 1))?.[0] ?? digit;
    return spellOrdinal(Number(start));
  });
  // A bare four-digit number in prose is usually a year.
  output = output.replace(/\b(1[1-9]\d{2}|20\d{2})\b/g, (match) => spellYear(Number(match)));
  output = output.replace(/\b\d[\d,]*\.\d+\b/g, (match) => {
    const [whole, fraction] = match.replace(/,/g, '').split('.') as [string, string];
    return `${spellNumber(Number(whole))} point ${spellDigits(fraction)}`;
  });
  output = output.replace(/\b\d[\d,]*\b/g, (match) => {
    const value = Number(match.replace(/,/g, ''));
    // Long unpunctuated runs are identifiers, not quantities: read them out.
    return match.replace(/,/g, '').length > 9 ? spellDigits(match) : spellNumber(value);
  });
  output = output.replace(/\d/g, (digit) => ` ${ONES[Number(digit)]!} `);
  for (const [symbol, words] of Object.entries(SYMBOLS)) output = output.split(symbol).join(words);
  output = output.replace(/\b([a-z]+)\.(?=\s|$)/gi, (match, word: string) => {
    const expansion = ABBREVIATIONS[word.toLowerCase()];
    return expansion ? `${expansion} ` : match;
  });
  // Collapse anything the model has no symbol for, so it cannot break a word.
  output = output.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
  output = output.replace(/[_*`#<>[\]{}|\\/~^]/g, ' ');
  return output.replace(/\s+/g, ' ').trim();
}
