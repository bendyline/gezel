import { describe, expect, it } from 'vitest';
import { claimsGrounded } from './claims.js';
import type { WorkspaceLike } from './types.js';

function workspace(files: Record<string, string>): WorkspaceLike {
  return {
    read: async (f) => files[f] ?? null,
    list: async () => Object.keys(files),
  };
}

const BRIEF = [
  '# Returns desk pilot',
  'The pilot covered 18 SKUs.',
  'Median first response improved from 18 hours to 6 hours.',
  'Preventable refund leakage fell from 14.2% to 8.9%.',
].join('\n');

describe('claimsGrounded', () => {
  it('passes a deck whose figures appear in the source it cites', async () => {
    const deck = [
      '# Returns pilot',
      'The pilot covered 18 SKUs [1].',
      'Refund leakage fell from 14.2% to 8.9% [1].',
      '',
      '## Sources',
      '1. `source/brief.md`',
    ].join('\n');
    const r = await claimsGrounded(
      workspace({ 'deck.md': deck, 'source/brief.md': BRIEF }),
      'deck.md',
    );
    expect(r.ok).toBe(true);
    expect(r.counts.supported).toBe(2);
    expect(r.sources.read).toEqual(['source/brief.md']);
  });

  it('fails a cited figure the source does not contain', async () => {
    const deck = [
      'The pilot covered 24 SKUs [1].',
      '',
      '## References',
      '[1] `source/brief.md`',
    ].join('\n');
    const r = await claimsGrounded(
      workspace({ 'deck.md': deck, 'source/brief.md': BRIEF }),
      'deck.md',
    );
    expect(r.ok).toBe(false);
    expect(r.counts.unsupported).toBe(1);
    expect(r.detail).toContain('24');
  });

  it('reads inline (source: path) notes', async () => {
    const deck =
      'Median first response improved from 18 hours to 6 hours (source: `source/brief.md`).';
    const r = await claimsGrounded(
      workspace({ 'deck.md': deck, 'source/brief.md': BRIEF }),
      'deck.md',
    );
    expect(r.ok).toBe(true);
    expect(r.counts.supported).toBe(1);
  });

  it('fails a citation to a file that does not exist', async () => {
    const deck = [
      'The pilot covered 18 SKUs [1].',
      '',
      '## Sources',
      '1. `source/invented.md`',
    ].join('\n');
    const r = await claimsGrounded(workspace({ 'deck.md': deck }), 'deck.md');
    expect(r.ok).toBe(false);
    expect(r.counts.badCitations).toBe(1);
    expect(r.sources.missing).toEqual(['source/invented.md']);
  });

  it('counts a fact cited only to a URL as unverified, not invented', async () => {
    const deck = [
      'The pilot covered 31 SKUs [1].',
      '',
      '## Sources',
      '1. https://example.com/returns-pilot',
    ].join('\n');
    const r = await claimsGrounded(workspace({ 'deck.md': deck }), 'deck.md');
    expect(r.ok).toBe(true);
    expect(r.counts.unverified).toBe(1);
    expect(r.sources.unverifiable).toEqual(['https://example.com/returns-pilot']);
  });

  it('reads an uncited true fact from the supplied sources as a slip, and an invented one as a failure', async () => {
    const ws = workspace({
      'true.md': 'The pilot covered 18 SKUs.',
      'invented.md': 'The pilot covered 40 SKUs.',
      'source/brief.md': BRIEF,
    });
    const sources = ['source/brief.md'];
    expect((await claimsGrounded(ws, 'true.md', { sources })).ok).toBe(true);
    const invented = await claimsGrounded(ws, 'invented.md', { sources });
    expect(invented.ok).toBe(false);
    expect(invented.counts.uncited).toBe(1);
  });

  it('reads a cited folder as the files under it', async () => {
    const deck = ['Leakage fell to 8.9% [1].', '', '## Sources', '1. `corpus/`'].join('\n');
    const r = await claimsGrounded(
      workspace({ 'deck.md': deck, 'corpus/a.md': 'Nothing here.', 'corpus/b.md': BRIEF }),
      'deck.md',
    );
    expect(r.ok).toBe(true);
  });

  it('allows a budget of problems when the check asks for one', async () => {
    const deck = ['The pilot covered 24 SKUs [1].', '', '## Sources', '1. `source/brief.md`'].join(
      '\n',
    );
    const r = await claimsGrounded(
      workspace({ 'deck.md': deck, 'source/brief.md': BRIEF }),
      'deck.md',
      { maxUnsupported: 1 },
    );
    expect(r.ok).toBe(true);
  });

  it('reports a missing document', async () => {
    const r = await claimsGrounded(workspace({}), 'deck.md');
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('not found');
  });

  it('reads several references written on one Sources line', async () => {
    const report = [
      'Household of 4 [2].',
      'The pilot covered 18 SKUs [1].',
      '',
      '## Sources',
      '',
      '[1] source/brief.md [2] tasks/1/scope.md',
    ].join('\n');
    const r = await claimsGrounded(
      workspace({
        'report.md': report,
        'source/brief.md': BRIEF,
        'tasks/1/scope.md': 'A household of 4.',
      }),
      'report.md',
    );
    expect(r.counts.badCitations).toBe(0);
    expect(r.ok).toBe(true);
  });

  it('reads a Sources list laid out as a table', async () => {
    const report = [
      'The pilot covered 18 SKUs [13].',
      'Refund leakage fell from 14.2% to 8.9% [13].',
      '',
      '## Sources',
      '',
      '| Ref | Document |',
      '|-----|----------|',
      '| [13] | `source/brief.md` |',
    ].join('\n');
    const r = await claimsGrounded(
      workspace({ 'report.md': report, 'source/brief.md': BRIEF }),
      'report.md',
    );
    expect(r.counts.badCitations).toBe(0);
    expect(r.ok).toBe(true);
    expect(r.sources.read).toEqual(['source/brief.md']);
  });

  it('reads a field named beside its file as part of that file, not a second source', async () => {
    const report =
      'Refund leakage fell from 14.2% to 8.9% (source: source/brief.md, `pilot.leakage`).';
    const r = await claimsGrounded(
      workspace({ 'report.md': report, 'source/brief.md': BRIEF }),
      'report.md',
    );
    expect(r.ok).toBe(true);
    expect(r.sources.missing).toEqual([]);
  });

  it('reads a path a reference line puts in parentheses', async () => {
    const report = [
      'The pilot covered 18 SKUs [1].',
      '',
      '## References',
      '[1] Returns brief: the pilot scope. (source/brief.md) [2] Scope note (tasks/1/scope.md)',
    ].join('\n');
    const r = await claimsGrounded(
      workspace({
        'report.md': report,
        'source/brief.md': BRIEF,
        'tasks/1/scope.md': 'A household of 4.',
      }),
      'report.md',
    );
    expect(r.counts.badCitations).toBe(0);
    expect(r.ok).toBe(true);
  });

  it('accepts arithmetic on sourced figures, in the sentence or beside it', async () => {
    const deck = [
      '# Refund leakage',
      '- Before → after: **14.2% → 8.9%**, a 5.3-point drop (source: source/brief.md)',
      '# Response time',
      '- Median first response went from 18 hours to 6 hours (source: source/brief.md)',
      '- That is a **66%** reduction',
      '- And a 41% reduction in something else',
    ].join('\n');
    const r = await claimsGrounded(
      workspace({ 'deck.md': deck, 'source/brief.md': BRIEF }),
      'deck.md',
    );
    expect(r.counts.unsupported).toBe(0);
    expect(r.counts.uncited).toBe(1);
    expect(r.problems.join('\n')).toContain('41');
  });

  it('reads a source the document declares for itself, and still catches what is in none', async () => {
    const report = [
      '**Source:** `source/brief.md`',
      '',
      'The pilot covered **18 SKUs**.',
      'Leakage fell to 3.1%.',
    ].join('\n');
    const r = await claimsGrounded(
      workspace({ 'report.md': report, 'source/brief.md': BRIEF }),
      'report.md',
    );
    expect(r.counts.uncited).toBe(1);
    expect(r.problems.join('\n')).toContain('3.1');
    expect(r.problems.join('\n')).not.toContain('18');
  });

  it('reads an HTML page as the text its reader sees', async () => {
    const page = [
      '<!DOCTYPE html><html><head><title>Returns update - June 27, 2026</title>',
      '<style>body { font-size: 14px; line-height: 1.5; max-width: 600px; }</style></head>',
      '<body><h1>Returns update</h1>',
      '<p>Refund leakage fell from 14.2% to 8.9% <sup><a href="#s1">1</a></sup>.</p>',
      '<p>The pilot covered 24 SKUs (source: <code>source/brief.md</code>).</p>',
      '<h2>Sources</h2><ol><li id="s1"><code>source/brief.md</code></li></ol>',
      '</body></html>',
    ].join('\n');
    const r = await claimsGrounded(
      workspace({ 'digest.html': page, 'source/brief.md': BRIEF }),
      'digest.html',
    );
    expect(r.counts.supported).toBe(1);
    expect(r.counts.unsupported).toBe(1);
    expect(r.counts.uncited).toBe(0);
    expect(r.problems.join('\n')).toContain('24');
    expect(r.problems.join('\n')).not.toMatch(/14px|June|<title>/);
  });

  it('reads an HTML source without its markup', async () => {
    const report = 'The pilot covered 14 SKUs [1].\n\n## Sources\n1. `source/brief.html`';
    const brief =
      '<html><head><style>p { margin: 14px; }</style></head><body><p>18 SKUs.</p></body></html>';
    const r = await claimsGrounded(
      workspace({ 'report.md': report, 'source/brief.html': brief }),
      'report.md',
    );
    expect(r.ok).toBe(false);
    expect(r.counts.unsupported).toBe(1);
  });

  it('reads a bare file name as the one workspace file that carries it', async () => {
    const digest =
      'Leakage fell from 14.2% to 8.9%. [brief.md]\nThe pilot covered 24 SKUs. [brief.md]';
    const r = await claimsGrounded(
      workspace({ 'digest.md': digest, 'corpus/brief.md': BRIEF }),
      'digest.md',
    );
    expect(r.counts.badCitations).toBe(0);
    expect(r.counts.supported).toBe(1);
    expect(r.counts.unsupported).toBe(1);

    const shared = await claimsGrounded(
      workspace({ 'digest.md': digest, 'corpus/brief.md': BRIEF, 'old/brief.md': BRIEF }),
      'digest.md',
    );
    expect(shared.counts.badCitations).toBe(2);
  });

  it('reads a parenthesis of file names as a citation when the files exist', async () => {
    const digest = [
      'Leakage fell from 14.2% to 8.9% this quarter (brief.md)',
      'The pilot covered 24 SKUs (corpus/brief.md:2–3).',
      'Reships fell from 19 to 7 (ghost.md).',
      'The cap is 40 per load(brief.md).',
    ].join('\n');
    const r = await claimsGrounded(
      workspace({ 'digest.md': digest, 'corpus/brief.md': BRIEF }),
      'digest.md',
      { maxUncited: 5 },
    );
    expect(r.counts.supported).toBe(1);
    expect(r.counts.unsupported).toBe(1);
    expect(r.counts.badCitations).toBe(0);
    expect(r.counts.uncited).toBe(2);
    expect(r.sources.read).toEqual(['brief.md', 'corpus/brief.md:2–3']);
    expect(r.problems.join('\n')).toContain('"24"');
  });

  it('never reads the document as its own source', async () => {
    const report = [
      'The pilot covered 24 SKUs.',
      'We converted this report (`docs/report.md`) to DOCX at 29,177 bytes.',
      'Leakage fell to 3.1% (source: docs/report.md).',
      'Reships fell to 7 [1].',
      '',
      '## Sources',
      '1. `docs/`',
    ].join('\n');
    const r = await claimsGrounded(workspace({ 'docs/report.md': report }), 'docs/report.md', {
      maxUncited: 5,
    });
    expect(r.sources.read).toEqual([]);
    expect(r.counts.supported).toBe(0);
    expect(r.counts.uncited).toBe(2);
    expect(r.counts.badCitations).toBe(2);
  });

  it('reads a parenthesis that holds anything else as prose', async () => {
    const r = await claimsGrounded(
      workspace({
        'digest.md': 'The pilot covered 24 SKUs (see brief.md).',
        'brief.md': BRIEF,
      }),
      'digest.md',
      { maxUncited: 5 },
    );
    expect(r.counts.uncited).toBe(1);
    expect(r.counts.unsupported).toBe(0);
  });

  it('reads a bracketed path as a citation, but not a link', async () => {
    const deck = 'The pilot covered 18 SKUs [source/brief.md]. See [the brief](source/brief.md).';
    const r = await claimsGrounded(
      workspace({ 'deck.md': deck, 'source/brief.md': BRIEF }),
      'deck.md',
    );
    expect(r.ok).toBe(true);
    expect(r.counts.supported).toBe(1);
  });
});
