import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { matchStepHeading, segmentSkillBody } from './segment.js';
import { parseSkillDoc } from './skill-doc.js';

const FIXTURES = fileURLToPath(new URL('./__fixtures__', import.meta.url));
const read = (rel: string) => readFileSync(join(FIXTURES, rel), 'utf8');

describe('matchStepHeading', () => {
  it('recognizes the corpus heading variants', () => {
    expect(matchStepHeading('## Phase 1: Context Gathering')).toEqual({
      family: 'phase',
      ordinal: '1',
      title: 'Context Gathering',
    });
    expect(matchStepHeading('## Phase 2A: Startup Mode — YC Product Diagnostic')).toEqual({
      family: 'phase',
      ordinal: '2A',
      title: 'Startup Mode — YC Product Diagnostic',
    });
    expect(matchStepHeading('## Phase 2.5: Related Design Discovery')?.ordinal).toBe('2.5');
    expect(matchStepHeading('## Phase 2.75: Landscape Awareness')?.ordinal).toBe('2.75');
    expect(matchStepHeading('## Phase 4: Alternatives Generation (MANDATORY)')?.title).toBe(
      'Alternatives Generation (MANDATORY)',
    );
    expect(matchStepHeading('## Step 3 — Hypothesis Testing')).toEqual({
      family: 'step',
      ordinal: '3',
      title: 'Hypothesis Testing',
    });
    expect(matchStepHeading('## 2. Gather evidence')).toEqual({
      family: 'num',
      ordinal: '2',
      title: 'Gather evidence',
    });
    expect(matchStepHeading('## Philosophy')).toBeNull();
    expect(matchStepHeading('## What you have hands for')).toBeNull();
  });
});

describe('segmentSkillBody', () => {
  it('requires two same-family step headings for multi-step mode', () => {
    const single = segmentSkillBody('# T\n\nintro\n\n## Phase 1: Only\n\nbody');
    expect(single.family).toBeNull();
    const double = segmentSkillBody('# T\n\n## Phase 1: A\n\nx\n\n## Phase 2: B\n\ny');
    expect(double.family).toBe('phase');
    expect(double.stepIndices).toHaveLength(2);
  });

  it('segments investigate into its five phases', () => {
    const doc = parseSkillDoc(read('gstack/investigate/SKILL.md'), { fallbackName: 'investigate' });
    const seg = segmentSkillBody(doc.body);
    expect(seg.title).toBe('Systematic Debugging');
    expect(seg.family).toBe('phase');
    expect(seg.stepIndices).toHaveLength(5);
  });

  it('segments office-hours phases including decimals and letter modes', () => {
    const doc = parseSkillDoc(read('gstack/office-hours/SKILL.md'), {
      fallbackName: 'office-hours',
    });
    const seg = segmentSkillBody(doc.body);
    expect(seg.family).toBe('phase');
    expect(seg.stepIndices.length).toBeGreaterThanOrEqual(9);
    const headings = seg.stepIndices.map((i) => seg.sections[i]!.heading);
    expect(headings.some((h) => h.includes('Phase 2A'))).toBe(true);
    expect(headings.some((h) => h.includes('Phase 2.75'))).toBe(true);
  });

  it('keeps careful (no phase headings) in single-step mode', () => {
    const doc = parseSkillDoc(read('gstack/careful/SKILL.md'), { fallbackName: 'careful' });
    const seg = segmentSkillBody(doc.body);
    expect(seg.family).toBeNull();
    expect(seg.sections.length).toBeGreaterThanOrEqual(3);
  });
});
