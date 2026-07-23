import { describe, expect, it } from 'vitest';
import {
  extractDirectFileWorkPrerequisiteReadPaths,
  extractDirectFileWorkTargetPath,
  extractExplicitFileEditTools,
  extractSingleFileSourceRepairTargetPath,
  hasExplicitFullFileRewriteWording,
  isSingleFileSourceRepairRequest,
} from './direct-file-work-prompt.js';

describe('direct file-work prompt classification', () => {
  it('extracts multiple explicitly named inputs without treating the output as a source', () => {
    expect(
      extractDirectFileWorkPrerequisiteReadPaths(
        'Please read notes/a.txt and notes/b.txt, then produce the deliverable out/summary.md.',
      ),
    ).toEqual(['notes/a.txt', 'notes/b.txt']);
    expect(
      extractDirectFileWorkPrerequisiteReadPaths(
        'Use the supplied project context from brief.md and team.md: write the complete plan as plan.md.',
      ),
    ).toEqual(['brief.md', 'team.md']);
  });

  it('extracts a colon-delimited read-first list without requiring a nearby write verb', () => {
    const longInstructions =
      'Compare contradictions, preserve dates, and cite concrete evidence. '.repeat(12);
    expect(
      extractDirectFileWorkPrerequisiteReadPaths(
        `Read all five sources first: sources/a.md, sources/b.md, sources/c.md, sources/d.md, and sources/e.md. ${longInstructions}Write the grounded synthesis to out/report.md.`,
      ),
    ).toEqual(['sources/a.md', 'sources/b.md', 'sources/c.md', 'sources/d.md', 'sources/e.md']);
  });

  it('rejects an overlong colon-delimited prerequisite list instead of truncating it', () => {
    expect(
      extractDirectFileWorkPrerequisiteReadPaths(
        'Read all nine sources first: a.md, b.md, c.md, d.md, e.md, f.md, g.md, h.md, i.md. Write out.md.',
      ),
    ).toEqual([]);
  });

  it('ignores incidental paths when no explicit source clause exists', () => {
    expect(
      extractDirectFileWorkPrerequisiteReadPaths(
        'Create plan.md with an assumptions section and mention that team.md remains authoritative.',
      ),
    ).toEqual([]);
  });

  it('prefers the destination over the source in transform-shaped requests', () => {
    expect(
      extractDirectFileWorkTargetPath(
        'Normalize data/raw/customers.csv into out/customers.json and preserve source ordering.',
      ),
    ).toBe('out/customers.json');
    expect(
      extractDirectFileWorkTargetPath(
        'Convert `exports/people.tsv` to `public/people.json` using the declared mapping.',
      ),
    ).toBe('public/people.json');
    expect(
      extractDirectFileWorkTargetPath(
        'Merge records/a.csv and records/b.csv into the output file `records/all.csv`.',
      ),
    ).toBe('records/all.csv');
  });

  it('keeps an explicit deliverable contract authoritative', () => {
    expect(
      extractDirectFileWorkTargetPath(
        '[Deliverable expected as a FILE at `final/report.json`.] Normalize raw/input.csv into scratch/intermediate.json.',
      ),
    ).toBe('final/report.json');
  });

  it('binds a localized defect to its source module rather than an acceptance script', () => {
    const prompt =
      'Running `accept.mjs` fails; your job is to make it pass. The defect in `lib/paginate.mjs` is small once diagnosed. ' +
      'Read the module, leave the acceptance script untouched, and edit files in place.';

    expect(extractSingleFileSourceRepairTargetPath(prompt)).toBe('lib/paginate.mjs');
    expect(isSingleFileSourceRepairRequest(prompt)).toBe(true);
  });

  it('recognizes ordinary localized repair wording without internal tool names', () => {
    expect(
      isSingleFileSourceRepairRequest(
        'Please fix the one-line bug in `src/counter.ts` in place and preserve the current API.',
      ),
    ).toBe(true);
    expect(
      isSingleFileSourceRepairRequest('Create a new `src/counter.ts` implementation from scratch.'),
    ).toBe(false);
  });

  it('binds read-then-patch repair wording to the existing file', () => {
    const prompt =
      'The inline script has a parse error. Read `index.html`, then patch the existing file with the smallest syntax fix.';

    expect(extractSingleFileSourceRepairTargetPath(prompt)).toBe('index.html');
    expect(isSingleFileSourceRepairRequest(prompt)).toBe(true);
  });

  it('does not select a protected acceptance file merely because it should be read', () => {
    const prompt =
      'Read `accept.mjs` to understand the failure, but leave `accept.mjs` untouched. ' +
      'Make the suite pass; the underlying defect is small but its module is not yet known.';
    expect(extractSingleFileSourceRepairTargetPath(prompt)).toBeNull();
  });

  it('does not invert an explicit no-rewrite instruction when a generic annotation mentions writeFile', () => {
    const prompt =
      'Do not rewrite the whole file. Make the smallest targeted edit with replaceInFile. ' +
      '[Deliverable expected as a FILE at `index.html`. Your first assistant action should be the tool call `writeFile({ path, content })`.]';

    expect(hasExplicitFullFileRewriteWording(prompt)).toBe(false);
  });

  it('keeps an explicit append-only directive authoritative over a stale writeFile annotation', () => {
    const prompt =
      'Your next tool call must be `appendToFile({ path: "postmortem.md", content: "<new analysis>" })`. ' +
      'Do not call `writeFile`, rewrite existing sections, or answer in chat first. ' +
      '[Deliverable expected as a FILE at `postmortem.md`. Your first assistant action should be the tool call `writeFile({ path, content })`.]';

    expect(extractExplicitFileEditTools(prompt)).toEqual(['appendToFile']);
    expect(hasExplicitFullFileRewriteWording(prompt)).toBe(false);
  });

  it('extracts affirmative named edit tools but ignores negative mentions', () => {
    expect(
      extractExplicitFileEditTools(
        'Use targeted `replaceLines` edits, then call insertAtMarker({ path: "index.html" }). Do not call applyPatch.',
      ),
    ).toEqual(['replaceLines', 'insertAtMarker']);
  });

  it('still recognizes an affirmative complete rewrite request', () => {
    expect(
      hasExplicitFullFileRewriteWording(
        'Rewrite `src/store.ts` completely with `writeFile`; your next tool call should be writeFile.',
      ),
    ).toBe(true);
  });
});
