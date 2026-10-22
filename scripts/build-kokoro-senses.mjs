/**
 * Generate the Kokoro frontend's sense table: pronunciations that depend on
 * how a word is used, such as "present" the gift and "present" the verb.
 *
 * The voice pack's dictionaries hold one pronunciation per word. They are
 * flattened from misaki, Kokoro's reference frontend, whose gold dictionaries
 * keep a pronunciation per part of speech and choose among them with a tagger.
 * Flattening kept only the default, so a heteronym was always read one way.
 * This script restores the variants from the same gold dictionaries (the
 * hand-curated half; the eSpeak-derived silver half has no variants).
 *
 * Usage:
 *   node scripts/build-kokoro-senses.mjs [--source <dir with us_gold.json and gb_gold.json>]
 *
 * With no argument the pinned files are downloaded from GitHub and verified.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const destination = join(repo, 'packages/core/src/kokoro/senses-data.ts');
const lexicons = join(repo, 'packages/inference/assets/kokoro');

const MISAKI_COMMIT = 'fba1236595f2d2bf21d414ba6e57d25256afada3';
const SOURCES = {
  us: {
    file: 'us_gold.json',
    sha256: 'dc414872a49a28ae6c141463d502fd945f3b2fde040484fdc47d00cc4612686f',
  },
  gb: {
    file: 'gb_gold.json',
    sha256: '29e62f4b60261c88f7f3c2c7811ca3825978948090b72d2b27d565b729282f71',
  },
};

/**
 * misaki's tags, renamed where the frontend's cues name them differently.
 * `None` is the stressed form a function word takes at the end of a phrase
 * ("yes, we can"). `DT` (stressed "that") and `VBP` are left out: nothing in
 * the frontend can tell them apart, and misaki's `VBP` for "read" is the past
 * tense, which would be wrong for "I read every day".
 */
const SENSES = {
  NOUN: 'NOUN',
  VERB: 'VERB',
  ADJ: 'ADJ',
  ADV: 'ADV',
  VBD: 'VBD',
  VBN: 'VBN',
  None: 'FINAL',
};

/**
 * Words whose usual reading in documents is not misaki's default. Each moves
 * `sense` to the default and keeps the old default under `previous`, so a cue
 * can still reach it: "I am content" stays an adjective.
 */
const DEFAULT_SENSE = {
  content: { sense: 'NOUN', previous: 'ADJ' },
  contents: { sense: 'NOUN', previous: 'VERB' },
  affect: { sense: 'VERB', previous: 'NOUN' },
  affects: { sense: 'VERB', previous: 'NOUN' },
  implement: { sense: 'VERB', previous: 'NOUN' },
  implements: { sense: 'VERB', previous: 'NOUN' },
};

/**
 * Capitalised words misaki spells out when they name something (US, IT, ID),
 * except the ones a writer capitalises for emphasis or as an interjection.
 */
const SAID_AS_WORDS = new Set(
  'AH AM AS BE ETC HE HI HM HMM IN IS ISO ME MM OH OR RE WHO'.split(' '),
);

async function loadGold(language) {
  const { file, sha256 } = SOURCES[language];
  const explicit = process.argv.indexOf('--source');
  let bytes;
  if (explicit >= 0) {
    bytes = readFileSync(join(process.argv[explicit + 1], file));
  } else {
    const url = `https://raw.githubusercontent.com/hexgrad/misaki/${MISAKI_COMMIT}/misaki/data/${file}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Could not download ${url}: HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== sha256) throw new Error(`Checksum mismatch for ${file}`);
  return JSON.parse(bytes.toString('utf8'));
}

/** The staged dictionary, when present, to prove each default matches it. */
function loadLexicon(language) {
  const file = join(lexicons, `lexicon-${language}-en.txt.gz`);
  if (!existsSync(file)) return undefined;
  const entries = new Map();
  for (const line of gunzipSync(readFileSync(file)).toString('utf8').split('\n')) {
    const space = line.indexOf(' ');
    if (space <= 0) continue;
    const word = line.slice(0, space).toLowerCase();
    if (!entries.has(word))
      entries.set(
        word,
        line
          .slice(space + 1)
          .split(' ')
          .join(''),
      );
  }
  return entries;
}

function senseTable(language, gold) {
  const lexicon = loadLexicon(language);
  const lines = [];
  for (const [word, variants] of Object.entries(gold)) {
    if (!variants || typeof variants !== 'object' || word !== word.toLowerCase()) continue;
    if (lexicon && lexicon.get(word) !== variants.DEFAULT)
      throw new Error(`${language} "${word}": the dictionary and misaki disagree on its default`);
    const kept = {};
    for (const [tag, phonemes] of Object.entries(variants)) {
      if (SENSES[tag] && typeof phonemes === 'string') kept[SENSES[tag]] = phonemes;
    }
    const flip = DEFAULT_SENSE[word];
    if (flip) {
      if (!kept[flip.sense]) throw new Error(`"${word}" has no ${flip.sense} reading to promote`);
      kept.DEFAULT = kept[flip.sense];
      kept[flip.previous] = variants.DEFAULT;
      delete kept[flip.sense];
    }
    const pairs = Object.entries(kept).sort(([a], [b]) => a.localeCompare(b));
    if (!pairs.length) continue;
    lines.push(`${word} ${pairs.map(([tag, phonemes]) => `${tag}=${phonemes}`).join(' ')}`);
  }
  for (const word of Object.keys(DEFAULT_SENSE))
    if (!lines.some((line) => line.startsWith(`${word} `)))
      throw new Error(`${language} has no variants for "${word}"`);
  lines.sort();
  const text = lines.join('\n');
  if (/[`\\$]/.test(text)) throw new Error('Sense data cannot sit in a template literal');
  return lines;
}

function spelledCapitals(golds) {
  const spelled = new Set();
  for (const gold of golds)
    for (const [word, variants] of Object.entries(gold))
      if (/^[A-Z]{2,}$/.test(word) && variants?.NOUN === null && !SAID_AS_WORDS.has(word))
        spelled.add(word);
  return [...spelled].sort();
}

const us = await loadGold('us');
const gb = await loadGold('gb');
const tables = { us: senseTable('us', us), gb: senseTable('gb', gb) };
const capitals = spelledCapitals([us, gb]);

const wrap = (words) => {
  const rows = [];
  let row = '';
  for (const word of words) {
    if (row && row.length + word.length + 1 > 90) {
      rows.push(row);
      row = '';
    }
    row = row ? `${row} ${word}` : word;
  }
  if (row) rows.push(row);
  return rows.join('\n');
};

writeFileSync(
  destination,
  `/**
 * Pronunciations that depend on how a word is used, one table per dictionary.
 *
 * Each line is a word, then \`SENSE=phonemes\` pairs: the reading the word takes
 * in that use. A \`DEFAULT\` pair replaces the dictionary's own default for the
 * words documents use differently from misaki ("content" is usually a noun).
 * \`FINAL\` is the stressed form a function word takes at the end of a phrase.
 *
 * From misaki's gold dictionaries (Apache-2.0, hexgrad/misaki@${MISAKI_COMMIT.slice(0, 7)}).
 * Generated by scripts/build-kokoro-senses.mjs; do not hand-edit.
 */

export const KOKORO_SENSES_US = \`
${tables.us.join('\n')}
\`;

export const KOKORO_SENSES_GB = \`
${tables.gb.join('\n')}
\`;

/** Capitalised words read letter by letter when they name something: US, IT, ID. */
export const KOKORO_SPELLED_CAPITALS = \`
${wrap(capitals)}
\`;
`,
);
console.log(
  `wrote ${tables.us.length} American and ${tables.gb.length} British entries and ` +
    `${capitals.length} spelled capitals to ${destination}`,
);
