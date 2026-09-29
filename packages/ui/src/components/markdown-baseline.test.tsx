import { EditorShell } from '@bendyline/squisq-editor-react';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { markdownEquivalent, normalizeMarkdownBaseline } from './markdown-baseline.js';

// Content shaped like the project brief editors' stored values: prose with no
// trailing newline, and a list — the forms whose mount emissions read as
// edits before autosave lanes baselined on the canonical serialization.
const PROSE =
  'Fixture Project is the deterministic world the gezel web e2e suite renders. ' +
  'It exists to give the UI a stable project: a known name, a fixed mission, a ' +
  'handful of tasks, and one seeded conversation so screenshots never drift.';
const LIST = '- Render deterministically in screenshots\n- Carry tasks with steps';

async function mountEmissions(initial: string): Promise<string[]> {
  const out: string[] = [];
  render(<EditorShell initialMarkdown={initial} onChange={(src: string) => out.push(src)} />);
  await new Promise((r) => setTimeout(r, 80));
  return out;
}

describe('normalizeMarkdownBaseline', () => {
  it('is a fixed point: normalizing twice equals normalizing once', () => {
    for (const src of [PROSE, LIST, '', '# Title\n\nBody']) {
      const once = normalizeMarkdownBaseline(src);
      expect(normalizeMarkdownBaseline(once)).toBe(once);
    }
  });

  it('differs from raw stored text (the bug precondition this guards)', () => {
    expect(normalizeMarkdownBaseline(PROSE)).not.toBe(PROSE);
  });

  it('EditorShell settles its mount emissions on the baseline form', async () => {
    // Raw stored text: the editor emits at mount and settles on its
    // canonical serialization — which must be exactly our baseline, or
    // opening an editor reads as an edit.
    const emissions = await mountEmissions(PROSE);
    expect(emissions.length).toBeGreaterThan(0);
    expect(emissions[emissions.length - 1]).toBe(normalizeMarkdownBaseline(PROSE));
  });

  it('a baseline-seeded editor only ever emits the baseline at mount', async () => {
    for (const raw of [PROSE, LIST]) {
      const baseline = normalizeMarkdownBaseline(raw);
      const emissions = await mountEmissions(baseline);
      for (const src of emissions) expect(src).toBe(baseline);
    }
  });
});

// Model-written content shaped like the review's catering quote: prices, a
// hashtag line, and a table. Remark escapes the first two (`\$`, `\#`), and
// the editor shows those backslashes. Two-space hard breaks and bare `>`
// quote separators are left out: the pinned editor bridge still splits them
// into separate paragraphs at mount (fixed in squisq's tiptapBridge).
const QUOTE = [
  '## Catering Quote',
  '',
  '**Date:** May 20, 2026',
  '',
  '**Event Date:** Friday, October 10 at 8am',
  '',
  '| Item | Price |',
  '|------|-------|',
  '| Croissants | $3.50 |',
  '| Delivery Fee | $25.00 |',
  '',
  '#RiseAndCrumb #BakeryLife',
  '',
  'Total: $175.00',
].join('\n');

describe('markdownEquivalent', () => {
  it('treats the remark-escaped form as the same document', () => {
    const normalized = normalizeMarkdownBaseline(QUOTE);
    expect(normalized).toContain('\\$3.50');
    expect(markdownEquivalent(QUOTE, normalized)).toBe(true);
  });

  it('tells real edits apart', () => {
    expect(markdownEquivalent(QUOTE, QUOTE.replace('$3.50', '$3.75'))).toBe(false);
  });

  it('recognizes what a raw-seeded editor emits at mount', async () => {
    for (const raw of [PROSE, LIST, QUOTE]) {
      const emissions = await mountEmissions(raw);
      for (const src of emissions) expect(markdownEquivalent(src, raw)).toBe(true);
    }
  });

  it('a raw-seeded editor shows no escape backslashes', async () => {
    const { container } = render(<EditorShell initialMarkdown={QUOTE} />);
    await new Promise((r) => setTimeout(r, 80));
    const text = container.querySelector('.ProseMirror')?.textContent ?? '';
    expect(text).toContain('$3.50');
    expect(text).toContain('#RiseAndCrumb');
    expect(text).not.toContain('\\');
  });
});
