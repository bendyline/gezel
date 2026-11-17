import { describe, expect, it } from 'vitest';
import { digestPage, pageReadingText } from './page-digest.js';

const para = (topic: string, n: number) =>
  Array.from({ length: n }, (_, i) => `${topic} sentence ${i + 1} fills the paragraph.`).join(' ');

const LONG = [
  '# Pricing',
  'Gezel is free for one person and has plans for larger crews.',
  '## Personal',
  para('The personal plan', 30),
  '## Teams',
  `Teams pay per seat and get shared projects. ${para('The teams plan', 30)}`,
  '## Enterprise',
  para('The enterprise plan', 30),
  '## How the page looked',
  '![Top of the page](attachments/001/view-1.jpg)',
].join('\n\n');

describe('pageReadingText', () => {
  it('drops the screenshot section and image lines', () => {
    const text = pageReadingText(
      '# A\n\nHello.\n\n![x](a.png)\n\n## How the page looked\n\n![s](b.jpg)',
    );
    expect(text).toBe('# A\n\nHello.');
  });
});

describe('digestPage', () => {
  it('gives a page that fits whole, with its own description as the summary', () => {
    const digest = digestPage({
      markdown: '# Platform\n\nGezel runs on your computer and keeps your work in plain files.',
      description: 'The platform behind Gezel: local-first and inspectable.',
      query: 'Can you summarize https://gezel.com/platform?',
      budgetChars: 4000,
    });
    expect(digest.whole).toBe(true);
    expect(digest.text).toContain('plain files');
    expect(digest.summary).toBe('The platform behind Gezel: local-first and inspectable.');
    expect(digest.summarySource).toBe('description');
    expect(digest.shownWords).toBe(digest.words);
  });

  it('prefers a synopsis the index wrote, and falls back to the opening lines', () => {
    const base = { markdown: LONG, query: 'summarize', budgetChars: 100_000 };
    expect(digestPage({ ...base, synopsis: 'Plans and prices for Gezel.' })).toMatchObject({
      summary: 'Plans and prices for Gezel.',
      summarySource: 'synopsis',
    });
    expect(digestPage(base)).toMatchObject({
      summary: 'Gezel is free for one person and has plans for larger crews.',
      summarySource: 'opening',
    });
  });

  it('keeps the opening and the passage the question is about when the page is too long', () => {
    const digest = digestPage({
      markdown: LONG,
      query: 'What does https://gezel.com/pricing say about teams and seats?',
      budgetChars: 1600,
    });
    expect(digest.whole).toBe(false);
    expect(digest.text.startsWith('# Pricing')).toBe(true);
    expect(digest.text).toContain('Teams pay per seat');
    expect(digest.text).not.toContain('The enterprise plan sentence 30');
    expect(digest.text).toContain('[…]');
    expect(digest.text.length).toBeLessThanOrEqual(1700);
    expect(digest.shownWords).toBeLessThan(digest.words);
    expect(digest.text).not.toContain('How the page looked');
  });

  it('reads from the start when the question names nothing in the page', () => {
    const digest = digestPage({ markdown: LONG, query: 'summarize this', budgetChars: 1600 });
    expect(digest.text.startsWith('# Pricing')).toBe(true);
    expect(digest.text).toContain('## Personal');
  });

  it('cuts a single passage longer than the whole budget instead of returning nothing', () => {
    const digest = digestPage({ markdown: para('One', 200), query: '', budgetChars: 500 });
    expect(digest.whole).toBe(false);
    expect(digest.text.length).toBeGreaterThan(300);
    expect(digest.text.length).toBeLessThan(700);
  });
});
