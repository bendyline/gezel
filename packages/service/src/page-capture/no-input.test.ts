import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The capture browser never sends input to a page: no pointer, no keys, no
 * form filling, no synthetic events. That is what makes "visit a page" a read.
 * This test fails the build if any of those APIs appears in the code that
 * drives the capture browser (comments are ignored).
 */
const FILES = ['capture-worker.ts', 'extract-page.ts'];
const FORBIDDEN = [
  /\.click\s*\(/,
  /\.dblclick\s*\(/,
  /\.fill\s*\(/,
  /\.type\s*\(/,
  /\.press\s*\(/,
  /\.tap\s*\(/,
  /\.check\s*\(/,
  /\.uncheck\s*\(/,
  /\.hover\s*\(/,
  /\.selectOption\s*\(/,
  /\.setInputFiles\s*\(/,
  /\.dispatchEvent\s*\(/,
  /\.submit\s*\(/,
  /\.focus\s*\(/,
  /\bkeyboard\b/,
  /\bmouse\b/,
  /\btouchscreen\b/,
  /Input\.dispatch/,
];

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

describe('page capture sends no input', () => {
  for (const file of FILES) {
    it(`${file} uses no pointer, key or form API`, () => {
      const source = stripComments(readFileSync(new URL(`./${file}`, import.meta.url), 'utf8'));
      for (const pattern of FORBIDDEN)
        expect(source, `${file} matches ${pattern}`).not.toMatch(pattern);
    });
  }
});
