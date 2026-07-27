import { EditorShell } from '@bendyline/squisq-editor-react';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { normalizeMarkdownBaseline } from './markdown-baseline.js';

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
