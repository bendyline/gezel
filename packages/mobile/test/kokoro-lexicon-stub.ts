/**
 * Test stand-in for the dictionary assets the Vite plugin emits.
 *
 * The real build publishes the gzipped voice-pack dictionaries and the host
 * fetches them; under test a data: URL carrying a handful of words exercises
 * exactly the same fetch-and-inflate path.
 */
import { gzipSync } from 'node:zlib';

function dataUrl(lines: string[]): string {
  const packed = gzipSync(Buffer.from(lines.join('\n')));
  return `data:application/gzip;base64,${packed.toString('base64')}`;
}

export const kokoroLexiconUrls: Readonly<Record<'us' | 'gb', string>> = {
  us: dataUrl(['hello h ə l ˈ O', 'world w ˈ ɜ ɹ l d', 'cat k ˈ æ t', 'one w ˈ ʌ n']),
  gb: dataUrl(['hello h ə l ˈ Q', 'world w ˈ ɜ ː l d', 'cat k ˈ a t', 'one w ˈ ʌ n']),
};
