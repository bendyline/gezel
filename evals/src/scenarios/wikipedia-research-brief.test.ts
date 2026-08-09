import { describe, expect, it } from 'vitest';
import { checkWikipediaResearchBrief } from './wikipedia-research-brief.ts';

function validBrief(): string {
  const body = [
    '## Executive summary',
    'Charles Babbage designed a general-purpose mechanical computing machine with a store and mill. Ada Lovelace helped explain the proposed machine but did not build it. [WIKI-ENGINE-DESIGN]',
    '',
    '## Timeline',
    'Luigi Federico Menabrea published his French account of Babbage’s Turin lectures in 1842. [WIKI-MENABREA-1842] In 1843, Lovelace translated the paper and expanded it with Notes A-G. [WIKI-ADA-1843]',
    '',
    '## Findings and interpretation',
    'Note G described a Bernoulli-number algorithm for the proposed Engine. [WIKI-ADA-1843] Babbage’s design separated a store from a mill and used punched cards. [WIKI-ENGINE-DESIGN] The Engine was never completed in either Babbage’s or Lovelace’s lifetime. Describing Lovelace as the first computer programmer is common shorthand, but historians debate how broadly that label applies and how authorship should be divided.',
    '',
    '## Caveats',
    'The source cards document publications and machine plans, not a completed running machine. Interpretive claims should therefore be narrower than the surviving design record.',
    '',
    '## Sources',
    '- [WIKI-ADA-1843] Ada Lovelace, local snapshot revision.',
    '- [WIKI-ENGINE-DESIGN] Analytical Engine, local snapshot revision.',
    '- [WIKI-MENABREA-1842] Luigi Federico Menabrea, local snapshot revision.',
  ].join('\n');
  return `${body}\n\n${'The evidence supports a careful distinction between design, exposition, and execution. '.repeat(70)}`;
}

describe('wikipedia research brief grader', () => {
  it('accepts a cited, calibrated, source-grounded brief', () => {
    const result = checkWikipediaResearchBrief(validBrief());
    expect(result.ok).toBe(true);
    expect(result.score).toBe(result.scoreMax);
  });

  it('rejects a missing source id', () => {
    const result = checkWikipediaResearchBrief(
      validBrief().replaceAll('[WIKI-MENABREA-1842]', 'Menabrea source'),
    );
    expect(result.ok).toBe(false);
    expect(result.failReason).toMatch(/missing inline source ids/i);
  });

  it('rejects the false claim that Lovelace built the Engine', () => {
    const result = checkWikipediaResearchBrief(
      validBrief().replace(
        'helped explain the proposed machine but did not build it',
        'built the Analytical Engine',
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.missingRequiredSignals).toContain('no-false-completion');
  });

  it('does not read a correctly negated completion sentence as the false claim', () => {
    // Regression: the old document-wide regex matched the substring
    // "engine was completed in 1843" inside a sentence that denies it.
    const result = checkWikipediaResearchBrief(
      validBrief().replace(
        'The Engine was never completed in either Babbage’s or Lovelace’s lifetime.',
        'No part of the Engine was completed in 1843, and nothing resembling the full machine was completed in their lifetimes.',
      ),
    );
    expect(result.missingRequiredSignals ?? []).not.toContain('no-false-completion');
  });

  it('rejects an unhedged "first programmer" assertion even when "debate" appears elsewhere', () => {
    const result = checkWikipediaResearchBrief(
      validBrief().replace(
        'Describing Lovelace as the first computer programmer is common shorthand, but historians debate how broadly that label applies and how authorship should be divided.',
        'Historians debate the division of authorship. Lovelace was the first computer programmer.',
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.missingRequiredSignals).toContain('claim-calibration');
  });

  it('accepts the translation and the Notes in separate sections', () => {
    // Regression: chaining Lovelace + 1843 + "Notes A-G" through proximity
    // windows failed a brief that put them in Timeline and Findings.
    const split = validBrief()
      .replace(' and expanded it with Notes A-G.', '.')
      .replace(
        '## Findings and interpretation',
        '## Findings and interpretation\nShe appended Notes A through G to that translation.',
      );
    const result = checkWikipediaResearchBrief(split);
    expect(result.missingRequiredSignals ?? []).not.toContain('lovelace-1843');
    expect(result.missingRequiredSignals ?? []).not.toContain('notes-a-g');
  });

  it('rejects a brief that cites the off-topic decoy source', () => {
    const result = checkWikipediaResearchBrief(
      validBrief().replace(
        '## Sources',
        '## Sources\n- [WIKI-ENGINE-BAND] Analytical Engine (band), local snapshot revision.',
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.missingRequiredSignals).toContain('no-decoy-citation');
  });
});
