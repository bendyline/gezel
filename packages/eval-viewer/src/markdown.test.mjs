import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { JSDOM } from 'jsdom';
import { renderSafeMarkdown } from './markdown.ts';

function render(source) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  return renderSafeMarkdown(source, dom.window);
}

describe('eval viewer Markdown rendering', () => {
  it('preserves ordinary Markdown structure', () => {
    const html = render('# Result\n\n- one\n- two\n\n**done**');
    assert.match(html, /<h1>Result<\/h1>/);
    assert.match(html, /<li>one<\/li>/);
    assert.match(html, /<strong>done<\/strong>/);
  });

  it('removes scriptable HTML and unsafe URL protocols', () => {
    const html = render(`
<img src="x" onerror="alert(document.cookie)">
<script>alert('x')</script>
<a href="javascript:alert(1)">click</a>
<svg onload="alert(2)"><circle /></svg>
`);

    assert.doesNotMatch(html, /onerror|onload|javascript:|<script|<svg/i);
    assert.match(html, />click<\/a>/);
  });

  it('removes interactive form controls and inline styling', () => {
    const html = render(
      '<form><input value="secret"><button>Submit</button></form><p style="position:fixed">text</p>',
    );
    assert.doesNotMatch(html, /<form|<input|<button|style=/i);
    assert.match(html, /<p>text<\/p>/);
  });
});
