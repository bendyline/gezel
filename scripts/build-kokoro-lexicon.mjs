/**
 * Stage the Kokoro pronunciation assets the desktop daemon ships.
 *
 * Kokoro reads phonemes, not text. Mobile finds its dictionary inside the
 * pinned offline voice pack; the desktop daemon downloads only the model, so
 * the same dictionary files are staged here, gzipped, and read at first use.
 * Both hosts therefore pronounce a sentence identically.
 *
 * The dictionary replaces eSpeak NG, which cannot ship in a store build: eSpeak
 * NG is GPL-3 and Gezel is MIT.
 *
 * Usage:
 *   node scripts/build-kokoro-lexicon.mjs [--pack <folder of pinned voice-pack files>]
 *
 * With no argument the pinned files already fetched by
 * native/mobile/speech/build.py are used.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const pin = JSON.parse(readFileSync(join(repo, 'native/mobile/speech/pins.json'), 'utf8'))[
  'kokoro-model'
];
const destination = join(repo, 'packages/inference/assets/kokoro');
/** Voice-pack members the desktop daemon needs; the rest stay mobile-only. */
const WANTED = ['lexicon-us-en.txt', 'lexicon-gb-en.txt'];

function packPath() {
  const explicit = process.argv.indexOf('--pack');
  if (explicit >= 0) return process.argv[explicit + 1];
  return join(repo, 'native/mobile/.build/speech-deps', pin.dir);
}

const pack = packPath();
/** One voice-pack file, refused unless it matches its pin. */
function member(name) {
  const file = join(pack, name);
  if (!existsSync(file)) {
    throw new Error(
      `Voice pack file not found at ${file}. Fetch the pack first with:
  python3 native/mobile/speech/build.py android --fetch --models
or pass its folder with --pack.`,
    );
  }
  const bytes = readFileSync(file);
  if (createHash('sha256').update(bytes).digest('hex') !== pin.files[name])
    throw new Error(`Voice pack checksum mismatch for ${file}`);
  return bytes;
}

mkdirSync(destination, { recursive: true });
const inventory = {};
for (const name of WANTED) {
  const text = member(name);
  const packed = gzipSync(text, { level: 9 });
  writeFileSync(join(destination, `${name}.gz`), packed);
  inventory[`${name}.gz`] = {
    sha256: createHash('sha256').update(packed).digest('hex'),
    entries: text.toString('utf8').split('\n').filter(Boolean).length,
    bytes: packed.length,
  };
  console.log(
    `${name}.gz  ${(packed.length / 1024 / 1024).toFixed(2)} MB  ` +
      `${inventory[`${name}.gz`].entries.toLocaleString()} entries`,
  );
}
// The dictionaries are Apache-2.0 data; redistribution must carry the pack's
// license text beside them.
const license = member('LICENSE');
writeFileSync(join(destination, 'LICENSE'), license);
writeFileSync(
  join(destination, 'manifest.json'),
  `${JSON.stringify(
    {
      source: {
        url: pin.url,
        files: Object.fromEntries([...WANTED, 'LICENSE'].map((name) => [name, pin.files[name]])),
      },
      license: { file: 'LICENSE', sha256: createHash('sha256').update(license).digest('hex') },
      files: inventory,
    },
    null,
    2,
  )}\n`,
);
console.log(`staged ${WANTED.length} dictionaries and their LICENSE in ${destination}`);
