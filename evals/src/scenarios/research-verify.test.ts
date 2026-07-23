import { describe, expect, it } from 'vitest';
import {
  type ResearchTier,
  checkResearchBrief,
  researchRepairDirective,
  tierSpecForTest,
} from './research-verify.ts';

/** A correct, fully-cited brief for any tier (values are tier-stable). */
function referenceBrief(tier: ResearchTier): string {
  const lines = [
    '# Field study brief',
    '',
    '1. The Meridian network operates 47 monitoring stations (`signed/report-alpha.md`).',
    '2. The network achieved 99.2% uptime in 2025 (`signed/report-alpha.md`).',
    '3. It is operated by the Halvard Institute (`signed/report-alpha.md`).',
    '4. The deepest sensor sits at 1,840 m (`signed/report-beta.md`).',
  ];
  if (tier >= 2) {
    lines.push(
      '5. The 2026 operations budget is 3,640,000 EUR (`signed/budget-note.md`).',
      '6. The eastern expansion was deferred to 2027 (`signed/budget-note.md`).',
    );
  }
  return lines.join('\n');
}

describe('research-verify graders (three tiers, one builder)', () => {
  it.each([1, 2, 3] as const)('tier %s: the reference brief passes', async (tier) => {
    const spec = tierSpecForTest(tier);
    const check = await checkResearchBrief(referenceBrief(tier), spec);
    expect(check.failReason).toBeUndefined();
    expect(check.ok).toBe(true);
  });

  it.each([1, 2, 3] as const)('tier %s: a decoy value flips the grounding signal', async (tier) => {
    const spec = tierSpecForTest(tier);
    const decoyed = referenceBrief(tier).replace(
      '47 monitoring stations',
      '52 monitoring stations',
    );
    const check = await checkResearchBrief(decoyed, spec);
    expect(check.ok).toBe(false);
    expect(check.failReason).toMatch(/signed sources|decoy/i);
  });

  it('tier 3: the miles restatement from the unauthorized briefing fails', async () => {
    const spec = tierSpecForTest(3);
    const trapped = referenceBrief(3).replace('1,840 m', 'roughly 1.14 miles (1,840 m)');
    const check = await checkResearchBrief(trapped, spec);
    expect(check.ok).toBe(false);
  });

  it('an uncited brief fails citationsResolve', async () => {
    const spec = tierSpecForTest(1);
    const uncited = referenceBrief(1).replace(/\(`[^)]+`\)/g, '');
    const check = await checkResearchBrief(uncited, spec);
    expect(check.ok).toBe(false);
    expect(check.failReason).toMatch(/citation/i);
  });

  it.each([1, 2, 3] as const)(
    'tier %s generator consistency: canonical values ONLY in signed files, decoys ONLY outside',
    async (tier) => {
      const spec = tierSpecForTest(tier);
      const signedText = spec.files
        .filter((f) => spec.signedPaths.includes(f.path))
        .map((f) => f.content)
        .join('\n');
      const unsignedText = spec.files
        .filter((f) => !spec.signedPaths.includes(f.path) && f.path !== 'MANIFEST.md')
        .map((f) => f.content)
        .join('\n');
      for (const fact of spec.facts) {
        const requiredRe = new RegExp(fact.required[0]!, 'i');
        expect(requiredRe.test(signedText), `${fact.id} canonical in signed`).toBe(true);
        for (const forbidden of fact.forbidden ?? []) {
          const forbiddenRe = new RegExp(forbidden, 'i');
          expect(forbiddenRe.test(signedText), `${fact.id} decoy NOT in signed`).toBe(false);
          expect(forbiddenRe.test(unsignedText), `${fact.id} decoy planted outside`).toBe(true);
        }
      }
    },
  );

  it('the tier-3 repair directive teaches the trust chain', () => {
    expect(researchRepairDirective(3)).toContain('signed/INDEX.md');
    expect(researchRepairDirective(1)).toContain('MANIFEST.md');
  });
});
