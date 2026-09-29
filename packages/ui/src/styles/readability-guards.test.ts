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

  it('claims the media plan rows from the generic dialog label rules', () => {
    const stylesheet = css('home-view.css');
    expect(ruleBody(stylesheet, '.gz-dialog .home-media-plan-item')).toMatch(/display:\s*flex/);
    expect(ruleBody(stylesheet, '.gz-dialog .home-media-plan-item input[type="checkbox"]')).toMatch(
      /width:\s*auto/,
    );
  });
});
