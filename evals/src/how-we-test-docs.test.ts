import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { SUITES } from './suites.ts';

/**
 * The Handboek's "How we test models" page lists every test in the four
 * scorecard sets, and the model scorecard page links into each list by its
 * heading. Both are hand-written, so this keeps them honest: a set that gains
 * or loses a test fails here until the page says so, instead of the page
 * quietly describing a different set and the scorecard's links going dead.
 */
const docs = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'docs',
  'handboek',
  'technical',
);
const howWeTest = readFileSync(join(docs, 'how-we-test-models.md'), 'utf8');
const scorecard = readFileSync(join(docs, 'model-scorecard.md'), 'utf8');

const SETS = [
  { suiteId: 'core', heading: 'Core' },
  { suiteId: 'productivity', heading: 'Productivity' },
  { suiteId: 'developer', heading: 'Engineering' },
  { suiteId: 'complex-work', heading: 'Complex workflows' },
] as const;

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/** The table rows under one `### <heading> (<n> tests)` section. */
function section(heading: string): string {
  const start = howWeTest.search(new RegExp(`^### ${heading} \\(\\d+ tests\\)$`, 'm'));
  expect(start, `no "### ${heading} (n tests)" heading`).toBeGreaterThan(-1);
  const rest = howWeTest.slice(start + 4);
  const end = rest.search(/^#{2,3} /m);
  return end === -1 ? rest : rest.slice(0, end);
}

describe('How we test models', () => {
  for (const { suiteId, heading } of SETS) {
    const scenarios = SUITES[suiteId]!.scenarios;

    it(`lists every ${suiteId} test, and only those, under a heading with the right count`, () => {
      const title = `${heading} (${scenarios.length} tests)`;
      expect(howWeTest).toMatch(new RegExp(`^### ${title.replace(/[()]/g, '\\$&')}$`, 'm'));
      const listed = [...section(heading).matchAll(/^\| [^|]*\(\[`([a-z0-9-]+)`\]/gm)].map(
        (m) => m[1],
      );
      // The page may order tests for reading; it must name the same ones.
      expect([...listed].sort()).toEqual([...scenarios].sort());
    });

    it(`is linked from the model scorecard for ${suiteId}`, () => {
      const anchor = slug(`${heading} (${scenarios.length} tests)`);
      expect(scorecard).toContain(`how-we-test-models.md#${anchor}`);
    });
  }
});
