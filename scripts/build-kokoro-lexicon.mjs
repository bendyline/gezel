import { execFileSync } from 'node:child_process';
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
 *   node scripts/build-kokoro-lexicon.mjs [--pack <kokoro tarball>]
 *
 * With no argument the pinned pack already fetched by
 * native/mobile/speech/build.py is used.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const pins = JSON.parse(readFileSync(join(repo, 'native/mobile/speech/pins.json'), 'utf8'));
const destination = join(repo, 'packages/service/assets/kokoro');
/** Voice-pack members the desktop daemon needs; the rest stay mobile-only. */
const WANTED = ['lexicon-us-en.txt', 'lexicon-gb-en.txt'];

function packPath() {
  const explicit = process.argv.indexOf('--pack');
  if (explicit >= 0) return process.argv[explicit + 1];
  return join(repo, 'native/mobile/.build/speech-deps', pins['kokoro-model'].file);
}

const pack = packPath();
if (!pack || !existsSync(pack)) {
  throw new Error(
    `Voice pack not found at ${pack}. Fetch it first with:
  python3 native/mobile/speech/build.py android --fetch --models
or pass one with --pack.`,
  );
}
const digest = createHash('sha256').update(readFileSync(pack)).digest('hex');
if (digest !== pins['kokoro-model'].sha256)
  throw new Error(`Voice pack checksum mismatch for ${pack}`);

mkdirSync(destination, { recursive: true });
const inventory = {};
for (const name of WANTED) {
  // Read one member straight out of the archive; never unpack the whole pack.
  const text = execFileSync('tar', ['-xjOf', pack, `kokoro-int8-multi-lang-v1_0/${name}`], {
    maxBuffer: 64 * 1024 * 1024,
  });
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
writeFileSync(
  join(destination, 'manifest.json'),
  `${JSON.stringify({ source: pins['kokoro-model'], files: inventory }, null, 2)}\n`,
);
console.log(`staged ${WANTED.length} dictionaries in ${destination}`);
