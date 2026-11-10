import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// jsdom computes no cascade or layout, so these guard the rules themselves.
const css = (name: string) => readFileSync(resolve(import.meta.dirname, name), 'utf8');

function ruleBody(stylesheet: string, selector: string): string | undefined {
  const start = stylesheet.indexOf(`${selector} {`);
  if (start < 0) return undefined;
  return stylesheet.slice(start, stylesheet.indexOf('}', start));
}

describe('readability guards', () => {
  it('keeps words whole in chat tables despite the bubble anywhere-break', () => {
    const body = ruleBody(css('shared-content.css'), '.msg-body-rendered :is(table, th, td)');
    expect(body).toMatch(/overflow-wrap:\s*normal/);
    expect(body).toMatch(/word-break:\s*normal/);
  });

  // Squisq's own rules load later, from inside the view, and size a reply's
  // heading 1.6em (32px in its page register) with numerals a size up.
  it('keeps a chat reply at chat scale: no heading past 1.25em, numerals at text size', () => {
    const stylesheet = css('shared-content.css').replace(/\s+/g, ' ');
    const scope = '.msg-body-rendered .squisq-linear-content.squisq-page';
    const sizes = [...stylesheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter(([, selector]) => selector!.includes(scope))
      .map(([, selector, body]) => ({
        selector: selector!.trim(),
        size: /font-size:\s*([\d.]+)em/.exec(body!)?.[1],
      }));
    const sizeOf = (part: string) => sizes.find((rule) => rule.selector.includes(part))?.size;

    expect(sizeOf('.squisq-page-prose :is(h1, h2)')).toBe('1.25');
    expect(sizeOf('.squisq-page-banner-title')).toBe('1.25');
    expect(sizeOf('.squisq-page-items-title')).toBe('1.25');
    expect(sizeOf('.squisq-page-items li::before')).toBe('1');
    for (const rule of sizes) expect(Number(rule.size)).toBeLessThanOrEqual(1.25);
  });

  it('claims the media plan rows from the generic dialog label rules', () => {
    const stylesheet = css('home-view.css');
    expect(ruleBody(stylesheet, '.gz-dialog .home-media-plan-item')).toMatch(/display:\s*flex/);
    expect(ruleBody(stylesheet, '.gz-dialog .home-media-plan-item input[type="checkbox"]')).toMatch(
      /width:\s*auto/,
    );
  });
});
