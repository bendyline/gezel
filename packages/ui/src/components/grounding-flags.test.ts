import { describe, expect, it } from 'vitest';
import { findSentenceRanges } from './grounding-flags.js';

function rendered(html: string): HTMLElement {
  const div = document.createElement('div');
  div.innerHTML = html;
  document.body.append(div);
  return div;
}

describe('findSentenceRanges', () => {
  it('finds a checked sentence across formatting and its citation marker', () => {
    const body = rendered(
      '<p>Latte sold most. <strong>Sunday</strong> was the busiest day, with $4,182.50 <a href="#c1">[1]</a>.</p>',
    );
    const [range] = findSentenceRanges(body, ['**Sunday** was the busiest day, with $4,182.50.']);
    expect(range?.toString()).toBe('Sunday was the busiest day, with $4,182.50 [1].');
  });

  it('falls back to the opening words when the renderer changed the rest', () => {
    const body = rendered(
      '<p>The busiest weekday was Sunday, at $4,182.50 on average. Saturday came second.</p>',
    );
    const [range] = findSentenceRanges(body, [
      'The busiest weekday was Sunday, at an average of $4,182.50.',
    ]);
    expect(range?.toString()).toBe('The busiest weekday was Sunday, at $4,182.50 on average.');
  });

  it('marks nothing it cannot find', () => {
    const body = rendered('<p>Nothing like it here.</p>');
    expect(findSentenceRanges(body, ['Sunday was the busiest day of October.'])).toEqual([]);
  });
});
