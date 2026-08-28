import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FITNESS_MIN_TPS,
  type FitnessEvidence,
  buildFitnessChecks,
  fitnessMinTps,
} from './checks.js';

function evidence(overrides: Partial<FitnessEvidence> = {}): FitnessEvidence {
  return {
    toolCall: { name: 'write_file', argumentsJson: '{"path":"proeve.txt","content":"PROEVE OK"}' },
    genTokensPerSec: 24.5,
    observedThinking: false,
    effectiveContextTokens: 65_536,
    minGenTokensPerSec: DEFAULT_FITNESS_MIN_TPS,
    ...overrides,
  };
}

describe('buildFitnessChecks', () => {
  it('all-ok evidence admits', () => {
    const { checks, admitted } = buildFitnessChecks(evidence());
    expect(admitted).toBe(true);
    for (const check of Object.values(checks)) expect(check.ok).toBe(true);
  });

  it('spawn error fails spawn and marks turn checks not-reached', () => {
    const { checks, admitted } = buildFitnessChecks(
      evidence({ spawnError: 'Not enough memory to run gemma…', genTokensPerSec: null }),
    );
    expect(admitted).toBe(false);
    expect(checks.spawn).toEqual({ ok: false, detail: 'Not enough memory to run gemma…' });
    expect(checks.throughput.detail).toMatch(/not reached/);
    expect(checks.toolRoundTrip.detail).toMatch(/not reached/);
  });

  describe('throughput', () => {
    it('null t/s is a non-gating pass', () => {
      const { checks, admitted } = buildFitnessChecks(evidence({ genTokensPerSec: null }));
      expect(checks.throughput.ok).toBe(true);
      expect(checks.throughput.detail).toMatch(/not measured/);
      expect(admitted).toBe(true);
    });
    it('below the floor fails; at the floor passes', () => {
      expect(buildFitnessChecks(evidence({ genTokensPerSec: 1.2 })).checks.throughput.ok).toBe(
        false,
      );
      expect(buildFitnessChecks(evidence({ genTokensPerSec: 3 })).checks.throughput.ok).toBe(true);
    });
    it('a generation-turn error fails throughput and not-reaches the tool check', () => {
      const { checks } = buildFitnessChecks(
        evidence({ generationError: 'timeout after 360000ms', genTokensPerSec: null }),
      );
      expect(checks.throughput.ok).toBe(false);
      expect(checks.throughput.detail).toMatch(/generation turn failed: timeout/);
      expect(checks.toolRoundTrip.detail).toMatch(/not reached/);
    });
  });

  describe('toolRoundTrip', () => {
    it('a well-formed call passes', () => {
      expect(buildFitnessChecks(evidence()).checks.toolRoundTrip.ok).toBe(true);
    });
    it('marker in the path alone is accepted (lenient match)', () => {
      const { checks } = buildFitnessChecks(
        evidence({
          toolCall: { name: 'write_file', argumentsJson: '{"path":"Proeve.txt","content":"OK"}' },
        }),
      );
      expect(checks.toolRoundTrip.ok).toBe(true);
    });
    it('no call → fail, quoting the prose the model produced instead', () => {
      const { checks } = buildFitnessChecks(
        evidence({ toolCall: null, toolTurnText: 'I cannot write files directly.' }),
      );
      expect(checks.toolRoundTrip.ok).toBe(false);
      expect(checks.toolRoundTrip.detail).toContain('I cannot write files');
    });
    it('wrong tool name → fail', () => {
      const { checks } = buildFitnessChecks(
        evidence({ toolCall: { name: 'writeFile', argumentsJson: '{"content":"proeve"}' } }),
      );
      expect(checks.toolRoundTrip.ok).toBe(false);
      expect(checks.toolRoundTrip.detail).toContain('"writeFile"');
    });
    it('unparseable arguments → fail', () => {
      const { checks } = buildFitnessChecks(
        evidence({ toolCall: { name: 'write_file', argumentsJson: '{oops proeve' } }),
      );
      expect(checks.toolRoundTrip.ok).toBe(false);
      expect(checks.toolRoundTrip.detail).toMatch(/unparseable/);
    });
    it('parsed args without the marker → fail', () => {
      const { checks } = buildFitnessChecks(
        evidence({
          toolCall: { name: 'write_file', argumentsJson: '{"path":"a.txt","content":"hi"}' },
        }),
      );
      expect(checks.toolRoundTrip.ok).toBe(false);
      expect(checks.toolRoundTrip.detail).toMatch(/no trace/);
    });
    it('tool-turn error → fail with the error', () => {
      const { checks } = buildFitnessChecks(
        evidence({ toolCall: undefined, toolTurnError: 'engine dropped the request' }),
      );
      expect(checks.toolRoundTrip.ok).toBe(false);
      expect(checks.toolRoundTrip.detail).toMatch(/tool turn failed: engine dropped/);
    });
  });

  describe('reasoningBudget', () => {
    it('finite budget passes; the 2^30 sentinel fails', () => {
      expect(
        buildFitnessChecks(evidence({ reasoningBudget: 6144 })).checks.reasoningBudget.ok,
      ).toBe(true);
      const sentinel = buildFitnessChecks(evidence({ reasoningBudget: 2147483647 }));
      expect(sentinel.checks.reasoningBudget.ok).toBe(false);
      expect(sentinel.checks.reasoningBudget.detail).toMatch(/unbounded sentinel/);
    });
    it('no budget + observed thinking fails; no budget + no thinking passes', () => {
      const thinking = buildFitnessChecks(evidence({ observedThinking: true }));
      expect(thinking.checks.reasoningBudget.ok).toBe(false);
      expect(thinking.checks.reasoningBudget.detail).toMatch(/no thinkingBudget cap/);
      expect(buildFitnessChecks(evidence()).checks.reasoningBudget.ok).toBe(true);
    });
  });

  describe('contextFit', () => {
    it('unknown context is a non-gating pass', () => {
      const { checks } = buildFitnessChecks(evidence({ effectiveContextTokens: undefined }));
      expect(checks.contextFit.ok).toBe(true);
    });
    it('below the 16K floor fails; at the floor passes', () => {
      expect(
        buildFitnessChecks(evidence({ effectiveContextTokens: 8192 })).checks.contextFit.ok,
      ).toBe(false);
      expect(
        buildFitnessChecks(evidence({ effectiveContextTokens: 16_384 })).checks.contextFit.ok,
      ).toBe(true);
    });
  });
});

describe('fitnessMinTps', () => {
  it('defaults to 3, honors a valid env override, ignores junk', () => {
    expect(fitnessMinTps({})).toBe(3);
    expect(fitnessMinTps({ GEZEL_FITNESS_MIN_TPS: '5.5' })).toBe(5.5);
    expect(fitnessMinTps({ GEZEL_FITNESS_MIN_TPS: 'fast' })).toBe(3);
    expect(fitnessMinTps({ GEZEL_FITNESS_MIN_TPS: '-1' })).toBe(3);
  });
});

describe('buildFitnessChecks — turns that ran out of budget mid-stream', () => {
  it('reads an unfinished generation as a verdict about the model, not a broken probe', () => {
    const { checks, admitted } = buildFitnessChecks(
      evidence({
        generationIncomplete: { elapsedMs: 562_000, observedTokens: 4_480 },
        genTokensPerSec: 8.06,
        genTokensPerSecEstimated: true,
      }),
    );

    expect(admitted).toBe(false);
    expect(checks.throughput.ok).toBe(false);
    // The tilde is the only signal that this rate is inferred rather than
    // reported, so it has to survive into the sentence a user reads.
    expect(checks.throughput.detail).toContain('~8.1 t/s');
    expect(checks.throughput.detail).toContain('9m 22s');
    expect(checks.throughput.detail).toContain('4,480');
    expect(checks.throughput.detail).toMatch(/engine is healthy/);
    // Nothing was learned about tools — say so rather than implying a failure.
    expect(checks.toolRoundTrip.reached).toBe(false);
  });

  it('an engine-reported rate carries no tilde', () => {
    const { checks } = buildFitnessChecks(
      evidence({
        generationIncomplete: { elapsedMs: 400_000, observedTokens: 3_000 },
        genTokensPerSec: 8.06,
      }),
    );
    expect(checks.throughput.detail).toContain('at 8.1 t/s');
    expect(checks.throughput.detail).not.toContain('~');
  });

  it('a tool turn that narrated past its deadline fails the tool axis, having reached it', () => {
    const { checks, admitted } = buildFitnessChecks(
      evidence({
        toolCall: undefined,
        toolTurnIncomplete: { elapsedMs: 180_000, observedTokens: 1_440 },
      }),
    );

    expect(admitted).toBe(false);
    expect(checks.toolRoundTrip.ok).toBe(false);
    expect(checks.toolRoundTrip.reached).toBeUndefined();
    expect(checks.toolRoundTrip.detail).toContain('without ever calling write_file');
    expect(checks.throughput.ok).toBe(true);
  });
});
