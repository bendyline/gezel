import { describe, expect, it } from 'vitest';
import {
  MIN_JUDGE_EVIDENCE_SUBSTRING,
  buildJudgePrompt,
  parseJudgeVerdict,
  validateJudgeEvidence,
} from './judge.js';

const ARTIFACT = [
  '# Customer notice',
  '',
  'We experienced a service interruption lasting 38 minutes on June 30.',
  'Affected customers will receive an automatic service credit on the next invoice.',
  'We have re-issued the TLS certificates involved and rotated all related keys.',
].join('\n');

describe('parseJudgeVerdict', () => {
  const VALID =
    '{"verdict":"fail","reasons":["tone too casual"],"evidence":["We experienced a service interruption lasting 38 minutes"]}';

  it('accepts a bare JSON object', () => {
    const v = parseJudgeVerdict(VALID);
    expect(v.verdict).toBe('fail');
    expect(v.reasons[0]).toBe('tone too casual');
  });

  it('accepts a ```json fenced block', () => {
    const v = parseJudgeVerdict(`Here is my verdict:\n\`\`\`json\n${VALID}\n\`\`\`\nDone.`);
    expect(v.verdict).toBe('fail');
  });

  it('accepts JSON embedded in prose (first { to last })', () => {
    const v = parseJudgeVerdict(`After careful review, ${VALID} — that is my assessment.`);
    expect(v.verdict).toBe('fail');
    expect(v.evidence).toHaveLength(1);
  });

  it('parses a pass verdict with empty evidence', () => {
    const v = parseJudgeVerdict('{"verdict":"pass","reasons":["meets the rubric"],"evidence":[]}');
    expect(v.verdict).toBe('pass');
  });

  it('defaults omitted evidence to an empty array and strips unknown fields', () => {
    const v = parseJudgeVerdict(
      '{"verdict":"pass","reasons":["meets the rubric"],"confidence":"high","extra":true}',
    );
    expect(v).toEqual({
      verdict: 'pass',
      reasons: ['meets the rubric'],
      evidence: [],
      confidence: 'high',
    });
  });

  it('throws on prose with no JSON and on schema-invalid JSON', () => {
    expect(() => parseJudgeVerdict('I think it looks fine overall.')).toThrow();
    expect(() => parseJudgeVerdict('{"verdict":"maybe","reasons":[],"evidence":[]}')).toThrow();
    expect(() => parseJudgeVerdict('{"verdict":"pass","reasons":[""],"evidence":[]}')).toThrow();
    expect(() =>
      parseJudgeVerdict('{"verdict":"pass","reasons":["1","2","3","4","5","6"],"evidence":[]}'),
    ).toThrow();
    expect(() =>
      parseJudgeVerdict(
        '{"verdict":"pass","reasons":[],"evidence":"not-an-array","confidence":"certain"}',
      ),
    ).toThrow();
  });
});

describe('validateJudgeEvidence (the verbatim wall)', () => {
  const verdict = (evidence: string[]) => ({
    verdict: 'fail' as const,
    reasons: ['r'],
    evidence,
  });

  it('keeps a verbatim quote of sufficient length', () => {
    const { kept, dropped } = validateJudgeEvidence(
      verdict(['We experienced a service interruption lasting 38 minutes']),
      ARTIFACT,
    );
    expect(kept).toHaveLength(1);
    expect(dropped).toBe(0);
  });

  it('keeps a quote that matches after whitespace/case normalization', () => {
    const { kept } = validateJudgeEvidence(
      verdict(['we experienced a   service\ninterruption lasting 38 minutes']),
      ARTIFACT,
    );
    expect(kept).toHaveLength(1);
  });

  it('drops a fabricated quote (plausible but not in the artifact)', () => {
    const { kept, dropped } = validateJudgeEvidence(
      verdict(['We experienced a service interruption lasting 83 minutes on June 30.']),
      ARTIFACT,
    );
    expect(kept).toHaveLength(0);
    expect(dropped).toBe(1);
  });

  it(`drops quotes under the ${MIN_JUDGE_EVIDENCE_SUBSTRING}-char floor even when they appear in the artifact`, () => {
    const { kept, dropped } = validateJudgeEvidence(verdict(['38 minutes']), ARTIFACT);
    expect(kept).toHaveLength(0);
    expect(dropped).toBe(1);
  });

  it('separates kept and dropped in a mixed list', () => {
    const { kept, dropped } = validateJudgeEvidence(
      verdict([
        'Affected customers will receive an automatic service credit',
        'this sentence was never written in the artifact at all',
      ]),
      ARTIFACT,
    );
    expect(kept).toEqual(['Affected customers will receive an automatic service credit']);
    expect(dropped).toBe(1);
  });
});

describe('buildJudgePrompt', () => {
  it('carries the rubric, the artifact under its path, and the strict-JSON contract', () => {
    const p = buildJudgePrompt({
      rubric: 'calm, factual tone throughout',
      file: 'customer-notice.md',
      artifactText: ARTIFACT,
    });
    expect(p).toContain('Rubric: calm, factual tone throughout');
    expect(p).toContain('--- artifact: customer-notice.md ---');
    expect(p).toContain('STRICT JSON');
    expect(p).toContain('VERBATIM');
  });

  it('includes sources when given and omits the section when not', () => {
    const withSources = buildJudgePrompt({
      rubric: 'r',
      file: 'f.md',
      artifactText: 'a',
      sources: [{ path: 'voice-guide.md', text: 'Always write in the first person plural.' }],
    });
    expect(withSources).toContain('--- source: voice-guide.md ---');
    expect(withSources).toContain('first person plural');
    const withoutSources = buildJudgePrompt({ rubric: 'r', file: 'f.md', artifactText: 'a' });
    expect(withoutSources).not.toContain('Reference material');
  });

  it('drops the evidence rule when requireEvidence is false', () => {
    const relaxed = buildJudgePrompt({
      rubric: 'r',
      file: 'f.md',
      artifactText: 'a',
      requireEvidence: false,
    });
    expect(relaxed).not.toContain('VERBATIM');
    expect(relaxed).toContain('STRICT JSON');
  });

  it('truncates oversized artifacts and sources to their caps', () => {
    const p = buildJudgePrompt({
      rubric: 'r',
      file: 'big.md',
      artifactText: 'ø'.repeat(30_000),
      sources: [{ path: 's.md', text: 'ß'.repeat(10_000) }],
    });
    expect((p.match(/ø/g) ?? []).length).toBe(24_000);
    expect((p.match(/ß/g) ?? []).length).toBe(8_000);
  });
});
