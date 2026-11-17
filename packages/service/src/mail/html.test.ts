import { describe, expect, it } from 'vitest';
import { fallbackHtmlToMarkdown } from './html.js';

/** Fails when `fn` takes longer than a linear pass over its input could. */
function expectFast(fn: () => unknown, budgetMs = 1_000): void {
  const started = performance.now();
  fn();
  expect(performance.now() - started).toBeLessThan(budgetMs);
}

describe('fallbackHtmlToMarkdown', () => {
  it('drops script, style and head content and flattens the rest', () => {
    const md = fallbackHtmlToMarkdown(
      '<html><head><title>T</title><style>p{}</style></head><body>' +
        '<p>Hello <b>there</b> and <em>you</em></p><script>alert(1)</script>' +
        '<ul><li>one</li><li>two</li></ul>&amp; done</body></html>',
    );
    expect(md).toBe('Hello **there** and *you*\n- one\n- two\n\n& done');
  });

  it('turns links into text with their address, and drops script links', () => {
    expect(fallbackHtmlToMarkdown('<a href="https://x.test/a">Read</a>')).toBe(
      'Read (https://x.test/a)',
    );
    expect(fallbackHtmlToMarkdown('<a href="https://x.test/a">https://x.test/a</a>')).toBe(
      'https://x.test/a',
    );
    expect(fallbackHtmlToMarkdown('<a href="javascript:steal()">Click</a>')).toBe('Click');
    expect(fallbackHtmlToMarkdown('<a name="top">Top</a>')).toBe('Top');
  });

  it('an unclosed style or script takes the rest of the document with it', () => {
    expect(fallbackHtmlToMarkdown('<p>keep</p><style>secret css and more')).toBe('keep');
  });

  it('stays linear on hostile markup', () => {
    const n = 400_000;
    expectFast(() => fallbackHtmlToMarkdown('<style>'.repeat(n / 7)));
    expectFast(() => fallbackHtmlToMarkdown('<a href="x">'.repeat(n / 12)));
    expectFast(() => fallbackHtmlToMarkdown('<b>'.repeat(n / 3)));
    expectFast(() => fallbackHtmlToMarkdown('<'.repeat(n)));
    expectFast(() => fallbackHtmlToMarkdown(`${' '.repeat(n)}x`));
  });
});
