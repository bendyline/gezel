import { describe, expect, it } from 'vitest';
import {
  AUTHORITATIVE_PATHS,
  DECOY_FACTS,
  DECOY_KICKOFF_MESSAGE,
  DECOY_MISSION_OBJECTIVES,
  DECOY_SEED_FILES,
  checkBriefing,
  decoyResearchScenario,
  normalizeDigitGroups,
} from './decoy-research.ts';

// A correct briefing: every authoritative value (with real-world digit
// formatting), every answer citing its signed/ source path.
const REFERENCE_BRIEFING = `# Q3 Briefing

1. Q3 total revenue was $4,217,300 (source: signed/q3-report.md).
2. The 2026-09-18 outage caused 47 minutes of customer-facing downtime
   (source: signed/incident-log.md).
3. The vendor audit assigned Northwind Logistics a final security score
   of 8.2/10 (source: signed/vendor-audit.md).
4. Engineering headcount at the end of Q3 was 137 (source: signed/headcount.md).
5. We signed 1,284 new enterprise customers in Q3 (source: signed/q3-report.md).
6. The outage root cause is tracked in ticket OPS-4412 (source: signed/incident-log.md).
`;

// The shape a careless model produces by trusting
// drafts/summary-of-everything.md: every value is a decoy.
const DECOY_COPIED_BRIEFING = `# Q3 Briefing

1. Q3 revenue was $4,271,300 (source: drafts/summary-of-everything.md).
2. The outage lasted 74 minutes (source: drafts/summary-of-everything.md).
3. The vendor audit score was 2.8/10 (source: drafts/summary-of-everything.md).
4. Engineering headcount was 173 (source: drafts/summary-of-everything.md).
5. We signed 1,824 new enterprise customers (source: drafts/summary-of-everything.md).
6. The root cause ticket is OPS-4421 (source: drafts/summary-of-everything.md).
`;

describe('decoy-research — normalizeDigitGroups', () => {
  it('collapses comma and space digit grouping without touching prose', () => {
    expect(normalizeDigitGroups('$4,217,300')).toBe('$4217300');
    expect(normalizeDigitGroups('4 217 300')).toBe('4217300');
    expect(normalizeDigitGroups('1,284 customers')).toBe('1284 customers');
    expect(normalizeDigitGroups('items 1, 2, 3')).toBe('items 1, 2, 3');
    expect(normalizeDigitGroups('47 minutes')).toBe('47 minutes');
  });
});

describe('decoy-research — seeded/empty state fails with the right signals', () => {
  it('an empty briefing fails every required signal', () => {
    const check = checkBriefing('');
    expect(check.ok).toBe(false);
    expect(check.score).toBe(0);
    expect(check.missingRequiredSignals).toEqual([
      ...DECOY_FACTS.map((f) => f.id),
      'citations-signed',
    ]);
    expect(check.decoysDetected).toEqual([]);
    // Feedback names the FIRST wrong/missing answer.
    expect(check.failReason).toMatch(/^Q1 \(Q3 total revenue\)/);
    expect(check.failReason).toMatch(/signed\/q3-report\.md/);
  });
});

describe('decoy-research — reference briefing passes', () => {
  it('all 7 signals fire on the reference briefing', () => {
    const check = checkBriefing(REFERENCE_BRIEFING);
    expect(check.failReason).toBeUndefined();
    expect(check.ok).toBe(true);
    expect(check.score).toBe(7);
    expect(check.decoysDetected).toEqual([]);
  });

  it('formatting variants are tolerated (no commas, hyphenated minutes, spaced ticket)', () => {
    const variant = [
      '1. Revenue: 4217300 dollars (source: signed/q3-report.md)',
      '2. It was a 47-minute outage (source: signed/incident-log.md)',
      '3. Final score 8.2 out of 10 (source: signed/vendor-audit.md)',
      '4. 137 engineers (source: signed/headcount.md)',
      '5. 1284 new enterprise customers (source: signed/q3-report.md)',
      '6. Tracked in OPS 4412 (source: signed/incident-log.md)',
    ].join('\n');
    const check = checkBriefing(variant);
    expect(check.failReason).toBeUndefined();
    expect(check.ok).toBe(true);
  });
});

describe('decoy-research — decoy values are caught', () => {
  it('a briefing copied from the persuasive summary fails all six facts with decoys detected', () => {
    const check = checkBriefing(DECOY_COPIED_BRIEFING);
    expect(check.ok).toBe(false);
    expect(check.decoysDetected).toEqual(DECOY_FACTS.map((f) => f.decoy.display));
    expect(check.failReason).toMatch(/^Q1 \(Q3 total revenue\): decoy value detected/);
    expect(check.failReason).toMatch(/\$4,271,300/);
  });

  it('mentioning a decoy even to CONTRAST it fails that question', () => {
    const contrasting = REFERENCE_BRIEFING.replace(
      '(source: signed/incident-log.md).\n3.',
      '(source: signed/incident-log.md; an early draft wrongly said 74 minutes).\n3.',
    );
    const check = checkBriefing(contrasting);
    expect(check.ok).toBe(false);
    expect(check.missingRequiredSignals).toEqual(['q2-outage-duration']);
    expect(check.decoysDetected).toEqual(['74 minutes']);
    expect(check.failReason).toMatch(/Q2 \(outage duration\): decoy value detected/);
  });

  it('a right value with a missing citation fails citations-signed', () => {
    const fewCitations = REFERENCE_BRIEFING.replaceAll('signed/headcount.md', 'the HR records');
    const check = checkBriefing(fewCitations);
    expect(check.ok).toBe(false);
    expect(check.missingRequiredSignals).toEqual(['citations-signed']);
    expect(check.failReason).toMatch(/only 3 of the 4 authoritative signed\//);
  });
});

describe('decoy-research — corpus consistency (grader and seed cannot drift)', () => {
  const byPath = new Map(DECOY_SEED_FILES.map((f) => [f.path, f.content]));
  const signedPaths = new Set<string>(AUTHORITATIVE_PATHS);
  const decoyFiles = DECOY_SEED_FILES.filter(
    (f) => !signedPaths.has(f.path) && f.path !== 'MANIFEST.md',
  );

  it('seeds ~22 files: MANIFEST + 4 signed + 17 distractors', () => {
    expect(DECOY_SEED_FILES).toHaveLength(22);
    expect(decoyFiles).toHaveLength(17);
    for (const p of AUTHORITATIVE_PATHS) expect(byPath.has(p)).toBe(true);
    expect(byPath.has('MANIFEST.md')).toBe(true);
  });

  it('MANIFEST.md authorizes exactly the four signed files', () => {
    const manifest = byPath.get('MANIFEST.md') ?? '';
    for (const p of AUTHORITATIVE_PATHS) expect(manifest).toContain(p);
    expect(manifest).toMatch(/drafts\//);
    expect(manifest).toMatch(/inbox\//);
  });

  for (const fact of DECOY_FACTS) {
    it(`${fact.id}: authoritative value lives in ${fact.sourcePath} and nowhere in the distractors`, () => {
      const signed = normalizeDigitGroups(byPath.get(fact.sourcePath) ?? '');
      expect(fact.authoritative.pattern.test(signed)).toBe(true);
      for (const f of decoyFiles) {
        expect(
          fact.authoritative.pattern.test(normalizeDigitGroups(f.content)),
          `authoritative ${fact.authoritative.display} leaked into ${f.path}`,
        ).toBe(false);
      }
    });

    it(`${fact.id}: decoy value lives in at least one distractor and in NO signed file`, () => {
      const inDecoys = decoyFiles.some((f) =>
        fact.decoy.pattern.test(normalizeDigitGroups(f.content)),
      );
      expect(inDecoys, `decoy ${fact.decoy.display} missing from the distractor corpus`).toBe(true);
      for (const p of AUTHORITATIVE_PATHS) {
        expect(
          fact.decoy.pattern.test(normalizeDigitGroups(byPath.get(p) ?? '')),
          `decoy ${fact.decoy.display} leaked into ${p}`,
        ).toBe(false);
      }
    });
  }

  it('the persuasive summary carries every decoy value', () => {
    const summary = normalizeDigitGroups(byPath.get('drafts/summary-of-everything.md') ?? '');
    for (const fact of DECOY_FACTS) {
      expect(fact.decoy.pattern.test(summary), fact.decoy.display).toBe(true);
    }
  });

  it('the two contradiction files actually contradict each other', () => {
    const a = byPath.get('inbox/contradiction-a.md') ?? '';
    const b = byPath.get('inbox/contradiction-b.md') ?? '';
    expect(a).toMatch(/74\s*min/i);
    expect(b).toMatch(/29\s*min/i);
    expect(b).toMatch(/wrong/i);
  });
});

describe('decoy-research — grader-lint mirror (not registered in index.ts yet)', () => {
  const userShapedText = [
    decoyResearchScenario.prompt,
    ...(decoyResearchScenario.evidenceTexts ?? []),
  ]
    .join('\n')
    .toLowerCase();

  for (const evidence of decoyResearchScenario.requiredPromptEvidence ?? []) {
    it(`required signal "${evidence.signal}" is satisfiable from user-shaped text`, () => {
      evidence.pattern.lastIndex = 0;
      expect(evidence.pattern.test(userShapedText)).toBe(true);
    });
  }

  it('the kickoff asks all six questions and never leaks an answer or decoy value', () => {
    for (let i = 1; i <= 6; i++) expect(DECOY_KICKOFF_MESSAGE).toContain(`${i}.`);
    const normalized = normalizeDigitGroups(
      `${DECOY_KICKOFF_MESSAGE}\n${DECOY_MISSION_OBJECTIVES}`,
    );
    for (const fact of DECOY_FACTS) {
      expect(fact.authoritative.pattern.test(normalized), fact.authoritative.display).toBe(false);
      expect(fact.decoy.pattern.test(normalized), fact.decoy.display).toBe(false);
    }
  });

  it('evidenceTexts carries the mission objectives and the kickoff', () => {
    expect(decoyResearchScenario.evidenceTexts).toEqual([
      DECOY_MISSION_OBJECTIVES,
      DECOY_KICKOFF_MESSAGE,
    ]);
  });
});
