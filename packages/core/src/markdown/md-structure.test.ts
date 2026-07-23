import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractAllFences, findFirstH1, splitSections } from './md-structure.js';

const FIXTURES = fileURLToPath(new URL('../skills/__fixtures__', import.meta.url));

describe('splitSections', () => {
  it('never splits on a ## inside a fence; longer markers close shorter openers', () => {
    const text = [
      'intro',
      '```md',
      '## not a heading',
      '````',
      '## a real heading',
      '````',
      '```',
      '## fenced again',
      'body',
      '````',
      '## trailing heading',
    ].join('\n');
    const { preamble, sections } = splitSections(text.split('\n'));
    // The ```` line closes the ``` fence (same char, at least as long).
    expect(preamble).toContain('## not a heading');
    expect(sections.map((s) => s.heading)).toEqual(['## a real heading', '## trailing heading']);
    // The second ```` opened a 4-tick fence: the bare ``` inside is content,
    // so "## fenced again" never becomes a heading.
    expect(sections[0]!.body).toContain('## fenced again');
  });
});

describe('findFirstH1', () => {
  it('skips bash comments inside fenced preamble blocks (investigate fixture)', () => {
    const raw = readFileSync(join(FIXTURES, 'gstack/investigate/SKILL.md'), 'utf8');
    const lines = raw.split(/\r?\n/);
    const h1 = findFirstH1(lines);
    expect(h1?.title).toBe('Systematic Debugging');
    // The preamble carries fenced `# Conductor host:` comment lines well
    // before the real H1 — a naive scan would land on one of those.
    const naive = lines.findIndex((l) => /^#\s+/.test(l));
    expect(naive).toBeLessThan(h1!.index);
  });

  it('finds the office-hours H1 behind ~800 lines of fenced preamble', () => {
    const raw = readFileSync(join(FIXTURES, 'gstack/office-hours/SKILL.md'), 'utf8');
    const h1 = findFirstH1(raw.split(/\r?\n/));
    expect(h1?.title).toBe('YC Office Hours');
  });
});

describe('extractAllFences', () => {
  it('returns every closed fence with its tag, dropping an unclosed trailer', () => {
    const text = [
      '```bash',
      'echo hi',
      '```',
      'prose',
      '```ts',
      'const a = 1;',
      '```',
      '```sh',
      'dangling',
    ].join('\n');
    const fences = extractAllFences(text);
    expect(fences).toEqual([
      { lang: 'bash', code: 'echo hi' },
      { lang: 'ts', code: 'const a = 1;' },
    ]);
  });
});
