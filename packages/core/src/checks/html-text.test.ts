import { describe, expect, it } from 'vitest';
import { htmlAsMarkdown, isHtmlDocument } from './html-text.js';

describe('htmlAsMarkdown', () => {
  it('drops the head, styles, scripts and comments', () => {
    const md = htmlAsMarkdown(
      [
        '<!DOCTYPE html><html><head><title>Update - June 27, 2026</title>',
        '<style>body { font-size: 14px; color: #333; }</style></head>',
        '<body><!-- built 2026-11-05 --><p>Reships fell to 7.</p>',
        '<script>const max = 40;</script></body></html>',
      ].join('\n'),
    );
    expect(md).toBe('Reships fell to 7.');
  });

  it('drops a title and style written without a head', () => {
    expect(htmlAsMarkdown('<title>June 27</title><style>p{margin:4px}</style><p>Hello.</p>')).toBe(
      'Hello.',
    );
  });

  it('lays out headings, lists, tables, links and code as Markdown', () => {
    const md = htmlAsMarkdown(
      [
        '<h1>Digest</h1>',
        '<div>Leakage fell to <strong>8.9%</strong> <sup><a href="#fn1">1</a></sup>.</div>',
        '<ul><li>One</li><li><a href="https://example.com/a?x=1&amp;y=2">Two</a></li></ul>',
        '<table><tr><th>Ref</th><th>File</th></tr><tr><td>2</td><td><p><code>a.md</code></p></td></tr></table>',
        '<h2>Sources</h2>',
        '<ol start="3"><li><p><code>source/brief.md</code></p></li><li>notes.md</li></ol>',
        '<pre><code>let x = 4;</code></pre>',
      ].join('\n'),
    );
    expect(md.split('\n')).toEqual([
      '# Digest',
      'Leakage fell to **8.9%** [1].',
      '- One',
      '- [Two](https://example.com/a?x=1&y=2)',
      '| Ref | File |',
      '| 2 | `a.md` |',
      '## Sources',
      '3. `source/brief.md`',
      '4. notes.md',
      '```',
      'let x = 4;',
      '```',
    ]);
  });

  it('decodes entities and collapses source whitespace', () => {
    expect(
      htmlAsMarkdown(
        '<p>\n  August&nbsp;15,\n  2026 &mdash; &#8220;on time&#x201D; &amp; 3 &lt; 4\n</p>',
      ),
    ).toBe('August 15, 2026 — “on time” & 3 < 4');
  });

  it('knows an HTML file by its extension or its first tag', () => {
    expect(isHtmlDocument('digest.html', 'Plain words.')).toBe(true);
    expect(isHtmlDocument('out/page.htm', '')).toBe(true);
    expect(isHtmlDocument('digest.txt', '<!doctype html><html></html>')).toBe(true);
    expect(isHtmlDocument('notes.md', 'Use <b>bold</b> sparingly.')).toBe(false);
  });
});
