import { describe, expect, it } from 'vitest';
import type { CraftbookStep } from '../schemas/craftbook.js';
import { craftbookStepStages, gerund, stepPersonLabel, stepStage } from './stage.js';

type Shape = Partial<CraftbookStep> & { id: string };

function book(...shape: Array<string | Shape>): CraftbookStep[] {
  const steps = shape.map((s) => (typeof s === 'string' ? { id: s } : s));
  return steps.map((s, i) => ({
    name: s.id,
    ...(i === steps.length - 1 ? { terminal: true } : { next: steps[i + 1]!.id }),
    ...s,
  })) as CraftbookStep[];
}

const stages = (steps: CraftbookStep[]) => [...craftbookStepStages(steps).values()].join(' > ');

// The most common shapes among gilde 0.2.7's 301 books, as their step ids.
describe('craftbookStepStages', () => {
  it.each([
    ['scope build evaluate finish', 'intake > make > check > check'],
    ['scope build verify evaluate finish', 'intake > make > check > check > check'],
    ['scope write review evaluate finish', 'intake > make > check > check > check'],
    ['scope research write evaluate finish', 'intake > make > make > check > check'],
    ['scope build test evaluate finish', 'intake > make > check > check > check'],
    ['outline write build evaluate finish', 'make > make > make > check > check'],
    [
      'offer-scope visual-design copy build evaluate finish',
      'intake > make > make > make > check > check',
    ],
    ['brief draft evaluate finish', 'intake > make > check > check'],
  ])('%s', (ids, want) => {
    expect(stages(book(...ids.split(' ')))).toBe(want);
  });

  it('counts a review or an audit as the work when nothing was made before it', () => {
    expect(stages(book('scope', 'verify', 'report', 'evaluate', 'finish'))).toBe(
      'intake > make > make > check > check',
    );
    expect(stages(book('scope', 'audit', 'report', 'evaluate', 'finish'))).toBe(
      'intake > make > make > check > check',
    );
  });

  it('reads a loop back, a gate that sends work back, and the step name', () => {
    const steps = book(
      { id: 'scope', name: 'Scope the week' },
      { id: 'draft', name: 'Draft the posts' },
      { id: 'polish', name: 'Tidy the wording', next: 'draft' },
      {
        id: 'judge',
        name: 'Judge it',
        gate: { at: 'completion', checks: [], onReject: 'draft' },
      } as Shape,
      { id: 'ship', name: 'Ship it' },
    );
    expect(stages(steps)).toBe('intake > make > check > check > check');
  });

  it("lets a step's own stage win", () => {
    const steps = book({ id: 'scope', stage: 'make' }, 'evaluate', 'finish');
    expect(stepStage(steps[0]!, steps)).toBe('make');
    expect(stages(steps)).toBe('make > check > check');
  });

  it('makes a one-step book', () => {
    expect(stages(book({ id: 'first-draft', name: 'First draft' }))).toBe('make');
  });
});

describe('stepPersonLabel', () => {
  it('turns the step name into what the gezel is doing', () => {
    expect(stepPersonLabel({ name: 'Draft the invoices' }, 'make')).toBe('drafting the invoices');
    expect(stepPersonLabel({ name: 'Map the routes' }, 'make')).toBe('mapping the routes');
    expect(stepPersonLabel({ name: 'Verify each claim' }, 'check')).toBe('verifying each claim');
    expect(stepPersonLabel({ name: 'Write the QA report' }, 'make')).toBe('writing the QA report');
    expect(stepPersonLabel({ name: 'Scope the week' }, 'intake')).toBe('working out the week');
    expect(stepPersonLabel({ name: 'Evaluate the deliverable' }, 'check', { noun: 'PDF' })).toBe(
      'checking your PDF',
    );
  });

  it('never shows a file name, a template token or a machinery word', () => {
    expect(stepPersonLabel({ name: 'Write `invoices.json` to the workspace' }, 'make')).toBe(
      'working on it',
    );
    expect(
      stepPersonLabel({ name: 'Render report.pdf for {{task.dir}}' }, 'make', { noun: 'PDF' }),
    ).toBe('making your PDF');
    expect(stepPersonLabel({ name: 'Copy the artifact over' }, 'check')).toBe('checking the work');
  });

  it("falls back to the stage's phrase for a bare name or a noun", () => {
    expect(stepPersonLabel({ name: 'Build' }, 'make', { noun: 'web page' })).toBe(
      'making your web page',
    );
    expect(stepPersonLabel({ name: 'Visual design' }, 'make')).toBe('working on it');
    expect(stepPersonLabel({ name: 'Evaluate' }, 'check')).toBe('checking the work');
    expect(stepPersonLabel({ name: 'Finish', terminal: true }, 'check')).toBe('wrapping up');
    expect(stepPersonLabel({ name: 'Offer scope' }, 'intake')).toBe(
      'getting clear on what you need',
    );
  });

  it("uses the step's own label", () => {
    expect(stepPersonLabel({ name: 'Build', personLabel: 'laying out the invoice' }, 'make')).toBe(
      'laying out the invoice',
    );
  });

  // 1.26300.100 showed "Soren is acquiring and verify sources" on every
  // PowerPoint request; 13 catalog books named steps this way.
  it('turns every verb the step name joins, and leaves nouns alone', () => {
    const label = (name: string) => stepPersonLabel({ name }, 'make');
    expect(label('Acquire and verify sources')).toBe('acquiring and verifying sources');
    expect(label('Review and write the report')).toBe('reviewing and writing the report');
    expect(label('Write and run the query')).toBe('writing and running the query');
    expect(label('Gather & triage changes')).toBe('gathering & triaging changes');
    expect(label('Reproduce & scope')).toBe('reproducing & scoping');
    expect(label('Implement the smallest fix and verify it')).toBe(
      'implementing the smallest fix and verifying it',
    );
    expect(label('Draft the post, then review it')).toBe('drafting the post, then reviewing it');
    expect(label('Extract actions & decisions')).toBe('extracting actions & decisions');
    expect(label('Review for completeness and tone')).toBe('reviewing for completeness and tone');
    expect(label('Publish the video and GIF')).toBe('publishing the video and GIF');
  });

  it('turns a verb into its -ing form', () => {
    expect(['write', 'plan', 'verify', 'tie', 'see', 're-measure', 'fix'].map(gerund)).toEqual([
      'writing',
      'planning',
      'verifying',
      'tying',
      'seeing',
      're-measuring',
      'fixing',
    ]);
  });
});
