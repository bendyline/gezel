import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

const ID = 'virtual:gezel-kokoro-lexicon';
/** Same gzipped dictionaries the daemon ships; staged by scripts/build-kokoro-lexicon.mjs. */
const SOURCE = fileURLToPath(new URL('../../service/assets/kokoro/', import.meta.url));
const FILES = { us: 'lexicon-us-en.txt.gz', gb: 'lexicon-gb-en.txt.gz' } as const;

/**
 * Publish Kokoro's pronunciation dictionaries as web assets.
 *
 * Speech runs in the WebView through the shared `@bendyline/gezel/kokoro`
 * frontend, so the dictionary has to be reachable from there. Emitting it as a
 * hashed asset keeps it out of the JavaScript bundle and lets the host fetch
 * and inflate it once, on first use.
 *
 * These are the very files the desktop daemon reads, which is what makes a
 * sentence sound the same on both. They replace eSpeak NG, which is GPL-3 and
 * cannot ship in a store build.
 */
export function kokoroLexiconPlugin(): Plugin {
  const urls: Record<string, string> = {};
  return {
    name: 'gezel-kokoro-lexicon',
    resolveId(id) {
      return id === ID ? `\0${ID}` : null;
    },
    buildStart() {
      for (const [language, file] of Object.entries(FILES)) {
        let bytes: Buffer;
        try {
          bytes = readFileSync(join(SOURCE, file));
        } catch (cause) {
          throw new Error(
            `Kokoro dictionary ${file} is missing — run node scripts/build-kokoro-lexicon.mjs`,
            { cause },
          );
        }
        // Android's asset packager treats a final .gz suffix specially: it
        // strips the suffix (and can inflate the payload) inside APKs. Publish
        // the same gzip bytes under a neutral name so the WebView URL and the
        // packaged bytes remain identical on both mobile platforms.
        const assetName = file.replace(/\.txt\.gz$/, '.bin');
        const reference = this.emitFile({ type: 'asset', name: assetName, source: bytes });
        urls[language] = reference;
      }
    },
    load(id) {
      if (id !== `\0${ID}`) return null;
      const entries = Object.entries(urls)
        .map(([language, reference]) => `  ${language}: import.meta.ROLLUP_FILE_URL_${reference},`)
        .join('\n');
      return `export const kokoroLexiconUrls = {\n${entries}\n};\n`;
    },
  };
}
