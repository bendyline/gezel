import { describe, expect, it } from 'vitest';
import { parseRobots, robotsAllows, robotsPatternMatches } from './website-crawl.js';

/** The RegExp matcher this replaced: same meaning, exponential on some rules. */
function regexMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$');
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split('*')
    .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`).test(path);
}

describe('robotsPatternMatches', () => {
  it('reads rules the way crawlers do', () => {
    expect(robotsPatternMatches('/private', '/private/notes')).toBe(true);
    expect(robotsPatternMatches('/private', '/public')).toBe(false);
    expect(robotsPatternMatches('/*.pdf$', '/docs/guide.pdf')).toBe(true);
    expect(robotsPatternMatches('/*.pdf$', '/docs/guide.pdf?x=1')).toBe(false);
    expect(robotsPatternMatches('/search*q=', '/search?lang=en&q=x')).toBe(true);
    expect(robotsPatternMatches('/', '/anything')).toBe(true);
    expect(robotsPatternMatches('/a$', '/a')).toBe(true);
    expect(robotsPatternMatches('/a$', '/ab')).toBe(false);
    expect(robotsPatternMatches('/(x)+?', '/(x)+?/y')).toBe(true);
  });

  it('agrees with the RegExp it replaced', () => {
    const alphabet = ['a', 'b', '/', '.', '*'];
    let seed = 7;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed;
    };
    const word = (n: number, chars: string[]) =>
      Array.from({ length: n }, () => chars[next() % chars.length]).join('');
    for (let i = 0; i < 3000; i++) {
      const pattern = `/${word(next() % 6, alphabet)}${next() % 3 === 0 ? '$' : ''}`;
      const path = `/${word(next() % 8, ['a', 'b', '/', '.'])}`;
      expect(robotsPatternMatches(pattern, path), `${pattern} vs ${path}`).toBe(
        regexMatches(pattern, path),
      );
    }
  });

  it('stays fast on a rule built to make a RegExp backtrack', () => {
    // A followed site wrote this; the old RegExp held the daemon's main thread
    // for seconds at seven stars and grew about fivefold per star.
    const pattern = `/${'*a'.repeat(25)}*b$`;
    const path = `/${'a'.repeat(5000)}`;
    const started = performance.now();
    expect(robotsPatternMatches(pattern, path)).toBe(false);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe('robotsAllows', () => {
  it('lets the longest rule win, and Allow win a tie', () => {
    const rules = parseRobots(
      ['User-agent: *', 'Disallow: /docs/', 'Allow: /docs/public/', 'Disallow: /*.zip$'].join('\n'),
    );
    expect(robotsAllows(rules, '/docs/secret')).toBe(false);
    expect(robotsAllows(rules, '/docs/public/page')).toBe(true);
    expect(robotsAllows(rules, '/files/big.zip')).toBe(false);
    expect(robotsAllows(rules, '/about')).toBe(true);
  });
});
