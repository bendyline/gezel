import { describe, expect, it } from 'vitest';
import {
  citedSentences,
  describeGroundingProblems,
  extractClaims,
  groundText,
  groundingProblems,
  parseCitationNumbers,
  stripCitations,
} from './citations.js';

const evidence = [
  {
    n: 1,
    title: 'George Washington',
    text: 'George Washington was born on February 22, 1732, at Popes Creek in the Colony of Virginia. He married Martha Dandridge Custis in January 1759. They had no children together.',
  },
  {
    n: 2,
    title: 'Martha Washington',
    text: 'Martha had four children with her first husband, Daniel Parke Custis; two survived infancy. Washington raised her children John Parke Custis and Martha Parke Custis.',
  },
];

describe('parseCitationNumbers', () => {
  it('reads single numbers, lists, and ranges', () => {
    expect(parseCitationNumbers('3')).toEqual([3]);
    expect(parseCitationNumbers('1, 4')).toEqual([1, 4]);
    expect(parseCitationNumbers('2-4')).toEqual([2, 3, 4]);
    expect(parseCitationNumbers('2–3, 5')).toEqual([2, 3, 5]);
  });
});

describe('citedSentences', () => {
  it('attaches each marker to its sentence, including one written after the full stop', () => {
    const out = citedSentences(
      'Washington was born in 1732 [1]. He married Martha Custis in 1759.[1] Mr. Washington had no children.',
    );
    expect(out).toEqual([
      { text: 'Washington was born in 1732.', cites: [1] },
      { text: 'He married Martha Custis in 1759.', cites: [1] },
      { text: 'Mr. Washington had no children.', cites: [] },
    ]);
  });

  it('skips code fences, headings and tables, and reads list items', () => {
    const out = citedSentences(
      '# Family\n\n```\nborn 1700\n```\n| a | b |\n- Martha had four children [2].',
    );
    expect(out).toEqual([{ text: 'Martha had four children.', cites: [2] }]);
  });
});

describe('extractClaims', () => {
  it('finds years, numbers, months, quotes and names', () => {
    const claims = extractClaims(
      'In January 1759 Washington married Martha Dandridge Custis, a widow with 2 children, calling it "the happiest day of my life" in a letter.',
    );
    expect(claims).toEqual(
      expect.arrayContaining([
        { kind: 'year', value: '1759' },
        { kind: 'month', value: 'January' },
        { kind: 'number', value: '2' },
        { kind: 'quote', value: 'the happiest day of my life' },
        { kind: 'name', value: 'Washington' },
        { kind: 'name', value: 'Martha' },
        { kind: 'name', value: 'Custis' },
      ]),
    );
  });

  it('reads a word after a bold label and colon as a clause start, not a name', () => {
    const names = extractClaims('**Augustine Washington Jr.**: Survived to adulthood.')
      .filter((c) => c.kind === 'name')
      .map((c) => c.value);
    expect(names).toEqual(['Augustine', 'Washington', 'Jr']);
  });

  it('ignores code spans and link targets', () => {
    expect(
      extractClaims('The `Store` class reads `config.json` (see [notes](https://x.org/a/1999)).'),
    ).toEqual([]);
  });

  it('does not treat a sentence-opening word as a name', () => {
    expect(extractClaims('They had no children together.')).toEqual([]);
    expect(extractClaims('However, the plan worked.')).toEqual([]);
  });

  it('reads the first word of a list item or quote line as a clause start', () => {
    const names = (text: string) =>
      extractClaims(text)
        .filter((c) => c.kind === 'name')
        .map((c) => c.value);
    expect(names('- **Caveat:** Absorbed sugars raise blood glucose quickly.')).toEqual([]);
    expect(names('1. **Salivary amylase** starts starch digestion.')).toEqual([]);
    expect(names('* Inside the small intestine, enzymes finish the job.')).toEqual([]);
    expect(names('> **Note:** Inside the cell, glucose is phosphorylated.')).toEqual([]);
    expect(names('- Ada Lovelace wrote the first published algorithm.')).toEqual([
      'Ada',
      'Lovelace',
    ]);
  });

  it('does not read a chemical formula as a name', () => {
    expect(extractClaims('Plants fix CO₂ during photosynthesis.')).toEqual([]);
    expect(extractClaims('Plants fix CO2 during photosynthesis.')).toEqual([]);
  });
});

describe('groundText', () => {
  it('passes details the cited evidence states', () => {
    const result = groundText(
      'Washington was born on February 22, 1732, in Virginia [1]. Martha had four children with Daniel Parke Custis [2].',
      evidence,
    );
    expect(result.sentences.map((s) => s.status)).toEqual(['supported', 'supported']);
  });

  it('flags a detail the cited evidence does not state', () => {
    const result = groundText('Washington was born in 1731 at Mount Vernon [1].', evidence);
    expect(result.sentences[0]?.status).toBe('unsupported');
    expect(result.sentences[0]?.missing).toEqual(
      expect.arrayContaining(['1731', 'Mount', 'Vernon']),
    );
  });

  it('tells a citation slip from an invention', () => {
    expect(
      groundText('Washington raised John Parke Custis [2].', evidence).sentences[0]?.status,
    ).toBe('supported');
    expect(
      groundText('Washington raised John Parke Custis [1].', evidence).sentences[0]?.status,
    ).toBe('unattributed');
    expect(groundText('Washington raised John Parke Custis.', evidence).sentences[0]?.status).toBe(
      'unattributed',
    );
    const invented = groundText('Washington raised John Parke Custis at Arlington [2].', evidence)
      .sentences[0];
    expect(invented?.status).toBe('unsupported');
    expect(invented?.missing).toEqual(['Arlington']);
  });

  it('separates uncited facts, bad citations, and prose with nothing to check', () => {
    const result = groundText(
      'Washington had a son named Samuel. Martha survived him [7]. This made for a close household [1]. It was a quiet life.',
      evidence,
    );
    expect(result.sentences.map((s) => s.status)).toEqual([
      'uncited',
      'bad-citation',
      'cited',
      'non-factual',
    ]);
    expect(result.counts.uncited).toBe(1);
  });

  it("accepts the person's own facts without a citation, and old numbers as unchecked", () => {
    const given = 'My grandfather Tomas Berg was born in 1921 in Duluth.';
    expect(
      groundText('Tomas Berg was born in 1921 in Duluth.', evidence, { given }).sentences[0]
        ?.status,
    ).toBe('supported');
    expect(
      groundText('Tomas Berg was born in 1922.', evidence, { given }).sentences[0]?.status,
    ).toBe('uncited');
    const opaque = (n: number) => n <= 9;
    expect(groundText('Martha survived him [7].', evidence, { opaque }).sentences[0]?.status).toBe(
      'cited',
    );
    expect(groundText('Martha survived him [12].', evidence, { opaque }).sentences[0]?.status).toBe(
      'bad-citation',
    );
  });

  it('flags the right relative with the wrong year, even when the year is elsewhere in the source', () => {
    const ev = [
      {
        n: 7,
        text: 'George Washington had five full siblings: Betty (1733), Samuel (1734), John Augustine (1736), Charles (1738) and Mildred (1739), who died in infancy. The family moved several times during these years, settling first on the Little Hunting Creek tract and later at Ferry Farm on the Rappahannock River near Fredericksburg. A 1737 survey of that tract survives among the county records.',
      },
    ];
    const wrong = groundText('Mildred Washington was born in 1737 [7].', ev).sentences[0];
    expect(wrong?.status).toBe('unsupported');
    expect(wrong?.missing).toEqual(['1737 next to Mildred']);
    expect(groundText('Mildred Washington was born in 1739 [7].', ev).sentences[0]?.status).toBe(
      'supported',
    );
    expect(groundText('Samuel Washington was born in 1734 [7].', ev).sentences[0]?.status).toBe(
      'supported',
    );
  });

  it('does not read a number from one source as detached from a name in another', () => {
    const ev = [
      { n: 1, text: 'Org chart: Launch DRI: Marcus (since June 1). Campaign lead: Iris.' },
      {
        n: 2,
        text: 'Engineering memo on Skylark readiness. The August date is not achievable: the migration alone takes six weeks, so this memo supersedes the product memo on timing and the launch date is 2026-09-01.',
      },
    ];
    const sentence = 'Skylark launches on 2026-09-01 with Marcus as launch DRI';
    expect(groundText(`${sentence}.`, ev).sentences[0]?.status).toBe('unattributed');
    expect(groundText(`${sentence} [1][2].`, ev).sentences[0]?.status).toBe('supported');
  });

  it('starts a sentence at a bold lead, so its label is not a name', () => {
    const ev = [{ n: 1, text: 'This memo supersedes the product memo on timing.' }];
    const result = groundText(
      'The engineering memo supersedes the product memo on timing [1]. **Winner:** the engineering memo.',
      ev,
    );
    expect(result.sentences.map((s) => s.status)).toEqual(['cited', 'non-factual']);
  });

  it('accepts a sum or difference the sentence works out from its own sourced numbers', () => {
    const ev = [
      { n: 1, text: 'The launch budget is 240,000 EUR.' },
      { n: 2, text: 'total_budget,210000' },
    ];
    expect(
      groundText('The 30,000 EUR gap between 240,000 and 210,000 is unexplained [1][2].', ev)
        .sentences[0]?.status,
    ).toBe('supported');
    expect(
      groundText('The gap is 30,000 EUR [1][2].', ev).sentences[0]?.status,
      'without its operands the number is unsourced',
    ).toBe('unsupported');
    expect(
      groundText('The 35,000 EUR gap between 240,000 and 210,000 is unexplained [1][2].', ev)
        .sentences[0]?.status,
    ).toBe('unsupported');
  });

  // incident-postmortem, 2026-10-07: metrics.csv and deploy.log were read in
  // full, and the postmortem's figures from them were refused.
  it('reads CSV columns as separate numbers, and does not anchor on acronyms or identifiers', () => {
    const ev = [
      {
        n: 1,
        text: '1→timestamp_utc,request_rate_per_s,error_rate_pct,p99_latency_ms,saturation_pct\n 2→14:25:00,1240,0.3,218,42\n 3→14:54:00,1198,0.9,238,46',
      },
      {
        n: 2,
        text:
          '# Timeline (UTC)\n\nIncident commander: Mira Chen\n\n' +
          'Notes on the on-call rotation and the review that followed. '.repeat(4) +
          '\n[2026-03-14T14:30:00Z] cd-pipeline 8147 START service=checkout-api pods=12 READY',
      },
    ];
    expect(
      groundText('p99 went from 218 ms to 238 ms, and errors fell to 0.9% [1].', ev).sentences[0]
        ?.status,
    ).toBe('supported');
    expect(
      groundText('At 14:30 UTC, CD pipeline 8147 rolled out to 12 pods [2].', ev).sentences[0]
        ?.status,
    ).toBe('supported');
    expect(
      groundText('**Error rate.** Baseline was 0.3% [1].', ev).sentences.map((x) => x.status),
    ).toEqual(['non-factual', 'supported']);
    expect(groundText('Clean IC handoff by Mira Chen.', ev).sentences[0]?.missing).toEqual(['IC']);
    expect(
      groundText('The estate covered 1,426 acres [1].', [{ n: 1, text: 'It covered 1,426 acres.' }])
        .sentences[0]?.status,
    ).toBe('supported');
  });

  it('pairs each year with the author nearest it in an author-year sentence', () => {
    const ev = [
      {
        n: 1,
        text:
          '1. Allen, Priya. 2022. Rural Telehealth Follow-up and Readmission Risk. Journal of Rural Care. Finds video follow-up within 72 hours lowered 30-day readmissions by 11% across four clinics; limitation: observational design.\n' +
          '2. Baker, Tom. 2021. Remote Monitoring Costs. Health Economics Notes. Cost model for remote monitoring programs.\n' +
          '3. Dunn, Elise. 2023. Nurse-led Coaching After Discharge. Care Transitions Quarterly. Randomized pilot, n=240; nurse coaching improved medication adherence by 18 points.',
      },
    ];
    expect(
      groundText(
        'Early video follow-up within 72 hours (Allen, 2022) and nurse-led coaching (Dunn, 2023) work best [1].',
        ev,
      ).sentences[0]?.status,
    ).toBe('supported');
    expect(
      groundText('Nurse-led coaching (Dunn, 2022) works best [1].', ev).sentences[0]?.missing,
    ).toEqual(['2022 next to Dunn']);
  });

  it('matches a name against its plural or possessive in the source', () => {
    const ev = [{ n: 1, text: 'Priya is the launch DRI. Weekly syncs on Tuesdays.' }];
    expect(groundText('The Tuesday sync may lapse [1].', ev).sentences[0]?.status).toBe(
      'supported',
    );
    expect(groundText('The Thursday sync may lapse [1].', ev).sentences[0]?.status).toBe(
      'unsupported',
    );
  });

  it('reads technical acronyms as vocabulary, decimals as thousandfold restatements, and file attributions as no anchor', () => {
    const ev = [
      { n: 1, text: '2→14:25:00,1240,0.3,218,42\n 3→14:35:00,1203,13.1,5180,99' },
      {
        n: 2,
        text: '[14:37:22] dmitri: all 504s on /charge. PR #3094 bumped timeout 800ms -> 8000ms',
      },
      {
        n: 3,
        text:
          '## Timeline\n\n- 14:30 deploy starts\n- 14:46 decision to revert\n\n' +
          'Context on rotations and staffing for the week. '.repeat(5) +
          '\n\n## Notes\n\nThe change was reviewed before merge.',
      },
    ];
    expect(groundText('All errors were HTTP 504 on /charge [2].', ev).sentences[0]?.status).toBe(
      'supported',
    );
    expect(
      groundText(
        'p99 reached 5.18 s, and a request now held its connection far past 0.8 s [1][2].',
        ev,
      ).sentences[0]?.status,
    ).toBe('supported');
    expect(
      groundText('The deploy started at 14:30 (timeline.md, Notes).', ev).sentences[0]?.missing ??
        [],
    ).not.toContainEqual(expect.stringContaining('next to Notes'));
    expect(groundText('p99 peaked near 5.2 s [1].', ev).sentences[0]?.status).toBe('supported');
    expect(groundText('p99 reached 5.19 s [1].', ev).sentences[0]?.status).toBe('unsupported');
  });

  it('lets a sentence that says it could not verify something stand', () => {
    const text =
      'I could not verify when Lawrence Washington died. His burial place is unconfirmed. No record names a third son.';
    expect(groundText(text, evidence).sentences.map((s) => s.status)).toEqual([
      'non-factual',
      'non-factual',
      'non-factual',
    ]);
    expect(groundText('Lawrence Washington died in 1752.', evidence).sentences[0]?.status).toBe(
      'uncited',
    );
  });

  it('matches thousands separators and spelled small numbers', () => {
    const ev = [{ n: 1, text: 'The estate covered 1,426 acres and two mills.' }];
    expect(
      groundText('The estate covered 1426 acres and 2 mills [1].', ev).sentences[0]?.status,
    ).toBe('supported');
  });

  // conflict-synthesis, 2026-10-07: each of these quotes is verbatim from the
  // memo the model had just read, and each was refused.
  it('finds a verbatim quote across a line break, a thousands comma, or the writer’s own punctuation', () => {
    const ev = [
      {
        n: 1,
        text: 'We are targeting a launch on 2026-08-15. The launch budget is 240,000 EUR,\ncovering the campaign, the event, and two contractors.',
      },
      {
        n: 2,
        text: 'Priya is the launch DRI. Weekly syncs on Tuesdays. This plan predates the\nreorg.',
      },
    ];
    for (const sentence of [
      'The memo states "The launch budget is 240,000 EUR" [1].',
      'It frames the figure as "covering the campaign, the event, and two contractors," [1].',
      'The old plan records "weekly syncs on Tuesdays," [2].',
      'The plan itself notes it "predates the reorg." [2]',
      'The memo says "The launch budget … covering the campaign" [1].',
    ]) {
      expect(groundText(sentence, ev).sentences[0]?.status, sentence).toBe('supported');
    }
    expect(
      groundText('The memo says "the launch budget is 250,000 EUR" [1].', ev).sentences[0]?.status,
    ).toBe('unsupported');
  });
});

describe('groundingProblems', () => {
  it('lists the sentences to fix, worst first, in words a model can act on', () => {
    const problems = groundingProblems(
      groundText(
        'Washington had a son named Samuel. He was born in 1731 [1]. Martha survived him [9].',
        evidence,
      ),
    );
    expect(problems.map((p) => p.status)).toEqual(['bad-citation', 'unsupported', 'uncited']);
    const text = describeGroundingProblems(problems);
    expect(text).toContain('cites [9], which is not in the evidence list');
    expect(text).toContain('"1731" not found in [1]');
    expect(text).toContain('cites nothing, and no evidence shows "Samuel"');
  });
});

describe('stripCitations', () => {
  it('removes markers without leaving stray spaces', () => {
    expect(stripCitations('Born in 1732 [1], married in 1759 [1, 2].')).toBe(
      'Born in 1732, married in 1759.',
    );
  });
});
