import { describe, expect, it } from 'vitest';
import { markdownToHtml } from './markdown-to-html.js';

describe('markdownToHtml', () => {
  it('converts the common shapes', () => {
    const html = markdownToHtml(
      [
        '# Title',
        '',
        'Some **bold** and *italic* and `code`.',
        '',
        '- one',
        '- two',
        '',
        '1. first',
        '2. second',
      ].join('\n'),
    );
    expect(html).toBe(
      '<h1>Title</h1><p>Some <strong>bold</strong> and <em>italic</em> and <code>code</code>.</p><ul><li>one</li><li>two</li></ul><ol><li>first</li><li>second</li></ol>',
    );
  });

  it('escapes markup the model did not ask for', () => {
    expect(markdownToHtml('<script>alert(1)</script>')).toBe(
      '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>',
    );
  });

  it('keeps code blocks verbatim and links only for http(s)', () => {
    expect(markdownToHtml('```\n<b>x</b>\n```')).toBe(
      '<pre><code>&lt;b&gt;x&lt;/b&gt;</code></pre>',
    );
    expect(markdownToHtml('[site](https://example.com) [bad](javascript:alert(1))')).toBe(
      '<p><a href="https://example.com">site</a> [bad](javascript:alert(1))</p>',
    );
  });

  it('joins wrapped lines into one paragraph', () => {
    expect(markdownToHtml('one\ntwo\n\nthree')).toBe('<p>one two</p><p>three</p>');
  });
});
