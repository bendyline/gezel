import { describe, expect, it } from 'vitest';
import { lintAllChatModelManifests, lintChatModelManifest } from './chat-model-manifest-lint.js';

/**
 * Ratchet test: the lint runs over the real catalog data. Known gaps are
 * enumerated below as a burn-down list — fixing a manifest requires
 * deleting its entry here (the test fails on stale entries too), and any
 * NEW gap fails immediately. This is what turns "the gemma4-26b-q4 QAT
 * swap silently deleted the tuning block and nobody noticed for days"
 * into a CI failure at commit time.
 */
const KNOWN_GAPS: ReadonlyArray<`${string} ${string}`> = [
  'gpt-oss-120b-q4 missing-tuning-sampling',
  'gpt-oss-120b-q4 missing-resident-bytes',
  'gpt-oss-20b-q4 missing-tuning-sampling',
  'mistral-medium-3.5-128b-q4 missing-resident-bytes',
  'nemotron3-nano-30b-q4 missing-resident-bytes',
  'nemotron3-super-120b-q4 missing-resident-bytes',
];

describe('chat-model manifest lint (ratchet over real catalog data)', () => {
  const report = lintAllChatModelManifests();

  it('lints every bundled chat model', () => {
    expect(report.modelCount).toBeGreaterThanOrEqual(20);
  });

  it('no NEW manifest gaps beyond the known burn-down list', () => {
    const found = report.errors.map((f) => `${f.modelId} ${f.rule}`);
    const newGaps = found.filter((f) => !KNOWN_GAPS.includes(f as `${string} ${string}`));
    expect(
      newGaps,
      'New manifest gap(s) detected. Either fix the manifest (preferred) or, if the gap is ' +
        'genuinely deferred, add it to KNOWN_GAPS with a burn-down plan.',
    ).toEqual([]);
  });

  it('burn-down list carries no stale entries (fixed manifests must be removed from it)', () => {
    const found = new Set(report.errors.map((f) => `${f.modelId} ${f.rule}`));
    const stale = KNOWN_GAPS.filter((g) => !found.has(g));
    expect(
      stale,
      'These KNOWN_GAPS entries no longer fire — delete them so the ratchet only moves forward.',
    ).toEqual([]);
  });
});

describe('lintChatModelManifest rules', () => {
  const complete = {
    id: 'test-model',
    parameterSize: '8B',
    style: { reasoningFormat: 'think' },
    tuning: {
      sampling: { temperature: 0.7 },
      reasoning: { thinkingBudget: 2048 },
      profiles: { 'thinking-general': {} },
    },
    behaviors: ['mcp.relax-required-fields', 'mcp.default-missing-fields'],
    llamaCpp: { residentBytes: 5_000_000_000 },
  };

  it('a complete manifest produces no findings', () => {
    const r = lintChatModelManifest(complete);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it.each(['OpenMDW-1.0', 'OpenMDW-1.1'])(
    '%s is permissive and must use the open license class',
    (license) => {
      expect(lintChatModelManifest({ ...complete, license, licenseClass: 'open' }).errors).toEqual(
        [],
      );
      expect(
        lintChatModelManifest({
          ...complete,
          license,
          licenseClass: 'custom-restricted',
        }).errors.map((f) => f.rule),
      ).toContain('openmdw-not-open');
      expect(lintChatModelManifest({ ...complete, license }).errors.map((f) => f.rule)).toContain(
        'openmdw-not-open',
      );
    },
  );

  it('missing tuning block is an error', () => {
    const { tuning: _drop, ...rest } = complete;
    const r = lintChatModelManifest(rest);
    expect(r.errors.map((f) => f.rule)).toContain('missing-tuning');
  });

  it('thinking model without a reasoning bound is an error; effort or enableThinking:false count as bounds', () => {
    const unbounded = { ...complete, tuning: { ...complete.tuning, reasoning: {} } };
    expect(lintChatModelManifest(unbounded).errors.map((f) => f.rule)).toContain(
      'unbounded-reasoning',
    );
    const effort = { ...complete, tuning: { ...complete.tuning, reasoning: { effort: 'high' } } };
    expect(lintChatModelManifest(effort).errors).toEqual([]);
    const disabled = {
      ...complete,
      tuning: { ...complete.tuning, reasoning: { enableThinking: false } },
    };
    expect(lintChatModelManifest(disabled).errors).toEqual([]);
    const nonThinking = {
      ...complete,
      style: { reasoningFormat: 'none' },
      tuning: { ...complete.tuning, reasoning: {} },
    };
    expect(lintChatModelManifest(nonThinking).errors).toEqual([]);
  });

  it('missing residentBytes on every backend is an error; any backend satisfies it', () => {
    const { llamaCpp: _drop, ...rest } = complete;
    expect(lintChatModelManifest(rest).errors.map((f) => f.rule)).toContain(
      'missing-resident-bytes',
    );
    expect(lintChatModelManifest({ ...rest, mlx: { residentBytes: 1 } }).errors).toEqual([]);
    expect(lintChatModelManifest({ ...rest, ds4: { residentBytes: 1 } }).errors).toEqual([]);
  });

  it('small model without rescue behaviors warns; large model does not', () => {
    const small = { ...complete, behaviors: ['turn.preamble-folding'] };
    expect(lintChatModelManifest(small).warnings.map((f) => f.rule)).toContain(
      'missing-small-model-rescue-behaviors',
    );
    const large = { ...small, parameterSize: '70B' };
    expect(lintChatModelManifest(large).warnings.map((f) => f.rule)).not.toContain(
      'missing-small-model-rescue-behaviors',
    );
  });
});
