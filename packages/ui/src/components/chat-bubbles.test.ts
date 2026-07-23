import { parseMarkdown } from '@bendyline/squisq/markdown';
import { describe, expect, it } from 'vitest';
import { isRawHtmlDump, toHtmlCodeFence } from './chat-bubbles.js';

/** Parse `md` and run the raw-HTML-dump heuristic the way RenderedMarkdown does. */
function dump(md: string): boolean {
  const nodes = parseMarkdown(md).children ?? [];
  return isRawHtmlDump(nodes as unknown as Parameters<typeof isRawHtmlDump>[0], md);
}

describe('isRawHtmlDump', () => {
  it('flags a full HTML document a gezel emitted', () => {
    const html =
      '<!DOCTYPE html>\n<html><head><style>body{font-family:monospace}' +
      'h1{text-shadow:0 0 10px magenta}</style></head>' +
      '<body><div id="game">Space Shooter</div></body></html>';
    expect(dump(html)).toBe(true);
  });

  it('flags a substantial HTML fragment even without page markers', () => {
    expect(dump(`<div class="card">${'x'.repeat(200)}</div>`)).toBe(true);
  });

  it('leaves plain prose alone', () => {
    expect(dump('Checking in on Space Shooter Arcade. Anything stuck?')).toBe(false);
  });

  it('leaves prose with light inline HTML alone (below the size floor)', () => {
    expect(dump('Press <kbd>Space</kbd> to shoot, or the arrow keys to move.')).toBe(false);
  });

  it('does not re-frame HTML the model already fenced (it parses as code, not raw HTML)', () => {
    expect(dump('```html\n<style>body{color:red}</style>\n<div>hi</div>\n```')).toBe(false);
  });
});

describe('toHtmlCodeFence', () => {
  it('wraps a message as an html code block (rendered as source, not live HTML)', () => {
    const src = '<style>body{color:red}</style>\n<div>hi</div>';
    const children = parseMarkdown(toHtmlCodeFence(src)).children ?? [];
    expect(children).toHaveLength(1);
    const node = children[0] as { type?: string; lang?: string; value?: string };
    expect(node.type).toBe('code');
    expect(node.lang).toBe('html');
    // The <style> survives as escaped source text, not a live element.
    expect(node.value).toContain('<style>');
  });

  it('uses a fence longer than any backtick run so content cannot break out', () => {
    // Single-quoted so the inner backticks are literal characters.
    const src = 'const x = `tpl`;\n```\nstill inside the block';
    const children = parseMarkdown(toHtmlCodeFence(src)).children ?? [];
    expect(children).toHaveLength(1);
    const node = children[0] as { type?: string; value?: string };
    expect(node.type).toBe('code');
    expect(node.value).toContain('still inside the block');
  });
});
