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

  it('nests list items by indentation, two spaces or four', () => {
    const tree = [
      '- **George Washington** (1732–1799)',
      "- Martha's children from her first marriage:",
      '  - John Parke Custis',
      '  - Martha Parke Custis',
      '- **Betty Washington** (1733–1797)',
    ].join('\n');
    expect(markdownToHtml(tree)).toBe(
      "<ul><li><strong>George Washington</strong> (1732–1799)</li><li>Martha's children from her first marriage:<ul><li>John Parke Custis</li><li>Martha Parke Custis</li></ul></li><li><strong>Betty Washington</strong> (1733–1797)</li></ul>",
    );
    expect(markdownToHtml('1. one\n    - a\n        - deep\n2. two')).toBe(
      '<ol><li>one<ul><li>a<ul><li>deep</li></ul></li></ul></li><li>two</li></ol>',
    );
  });

  it('keeps a list going across blank lines and indented continuations', () => {
    expect(markdownToHtml('- one\n\n- two\n  still two\n\nafter')).toBe(
      '<ul><li>one</li><li>two still two</li></ul><p>after</p>',
    );
  });

  it('starts a numbered list where the model numbered it', () => {
    expect(markdownToHtml('3. three\n4. four')).toBe(
      '<ol start="3"><li>three</li><li>four</li></ol>',
    );
  });

  it('hands mermaid fences to the diagram callback, and leaves them as code without one', () => {
    const md = 'Intro\n\n```mermaid\nflowchart TD\n  A --> B\n```';
    expect(markdownToHtml(md, { diagram: (source) => `[${source}]` })).toBe(
      '<p>Intro</p>[flowchart TD\n  A --> B]',
    );
    expect(markdownToHtml(md)).toBe(
      '<p>Intro</p><pre><code>flowchart TD\n  A --&gt; B</code></pre>',
    );
  });
});
