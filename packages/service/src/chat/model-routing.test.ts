import { describe, expect, it } from 'vitest';
import type { ResolvedModelFitness } from '../fitness/manager.js';
import {
  type ModelFitnessEvidence,
  type ModelGateEvidence,
  type RoutingCandidate,
  fitnessLookupFromRecords,
  modelRoutingDisabled,
  rankModelForFloor,
} from './model-routing.js';

function candidate(overrides: Partial<RoutingCandidate> & { modelId: string }): RoutingCandidate {
  return {
    provider: 'llama-cpp',
    tier: 'small',
    ...overrides,
  };
}

/** The dev-host fleet shape: e4b (small) + 20b/27b (medium), 27b default. */
const FLEET: RoutingCandidate[] = [
  candidate({ modelId: 'gemma4-e4b-q4', tier: 'small', parameterSizeB: 8 }),
  candidate({ modelId: 'gpt-oss-20b-q4', tier: 'medium', parameterSizeB: 20 }),
  candidate({ modelId: 'gemma4-26b-q4', tier: 'medium', parameterSizeB: 26 }),
  candidate({
    modelId: 'qwen3.6-27b-q4',
    tier: 'medium',
    parameterSizeB: 27,
    isDefault: true,
    isResident: true,
  }),
];

describe('rankModelForFloor', () => {
  it('floor=small downgrades to the cheapest clearing tier (e4b, not the 27b default)', () => {
    const pick = rankModelForFloor({ floor: 'small', candidates: FLEET });
    expect(pick?.model).toBe('gemma4-e4b-q4');
    expect(pick?.tier).toBe('small');
    expect(pick?.reason).toContain('floor=small');
  });

  it('floor=small excludes tiny models', () => {
    const pick = rankModelForFloor({
      floor: 'small',
      candidates: [
        candidate({ modelId: 'gemma4-e2b-q4', tier: 'tiny', parameterSizeB: 2.3 }),
        candidate({ modelId: 'gemma4-e4b-q4', tier: 'small', parameterSizeB: 8 }),
      ],
    });
    expect(pick?.model).toBe('gemma4-e4b-q4');
  });

  it('floor=medium prefers the config default within the qualifying tier (27b over 20b)', () => {
    const pick = rankModelForFloor({ floor: 'medium', candidates: FLEET });
    expect(pick?.model).toBe('qwen3.6-27b-q4');
    expect(pick?.reason).toContain('default');
  });

  it('floor=medium without a default picks strict-cheapest within the tier', () => {
    const noDefault = FLEET.map((c) => ({ ...c, isDefault: false, isResident: false }));
    const pick = rankModelForFloor({ floor: 'medium', candidates: noDefault });
    expect(pick?.model).toBe('gpt-oss-20b-q4');
  });

  it('prefer-resident breaks ties within a tier when neither is the default', () => {
    const pick = rankModelForFloor({
      floor: 'medium',
      candidates: [
        candidate({ modelId: 'a-20b', tier: 'medium', parameterSizeB: 20 }),
        candidate({ modelId: 'b-20b', tier: 'medium', parameterSizeB: 20, isResident: true }),
      ],
    });
    expect(pick?.model).toBe('b-20b');
    expect(pick?.reason).toContain('resident');
  });

  it('floor=large (or cloud) with no qualifying local model → null', () => {
    expect(rankModelForFloor({ floor: 'large', candidates: FLEET })).toBeNull();
    expect(rankModelForFloor({ floor: 'cloud', candidates: FLEET })).toBeNull();
  });

  it('empty candidates → null', () => {
    expect(rankModelForFloor({ floor: 'tiny', candidates: [] })).toBeNull();
  });

  it('unknown parameterSize sorts last within its tier', () => {
    const pick = rankModelForFloor({
      floor: 'small',
      candidates: [
        candidate({ modelId: 'mystery-small', tier: 'small' }),
        candidate({ modelId: 'known-small', tier: 'small', parameterSizeB: 8 }),
      ],
    });
    expect(pick?.model).toBe('known-small');
  });

  describe('fitness filter (advisory)', () => {
    const fitness =
      (map: Record<string, ModelFitnessEvidence>) => (provider: string, modelId: string) =>
        map[`${provider}:${modelId}`];

    it('fresh probed-and-rejected records exclude a candidate', () => {
      const pick = rankModelForFloor({
        floor: 'small',
        candidates: FLEET,
        fitness: fitness({
          'llama-cpp:gemma4-e4b-q4': { status: 'probed', admitted: false, stale: false },
        }),
      });
      expect(pick?.model).toBe('qwen3.6-27b-q4');
    });

    it('a measured decode rate below the floor excludes a candidate', () => {
      const pick = rankModelForFloor({
        floor: 'small',
        candidates: FLEET,
        fitness: fitness({
          'llama-cpp:gemma4-e4b-q4': {
            status: 'probed',
            admitted: true,
            genTokensPerSec: 1.2,
            stale: false,
          },
        }),
      });
      expect(pick?.model).toBe('qwen3.6-27b-q4');
    });

    it('failed, deferred, stale, and missing records never exclude', () => {
      for (const evidence of [
        { status: 'failed' as const, admitted: false, stale: false },
        { status: 'deferred' as const, admitted: false, stale: false },
        { status: 'probed' as const, admitted: false, stale: true },
        undefined,
      ]) {
        const pick = rankModelForFloor({
          floor: 'small',
          candidates: FLEET,
          fitness: () => evidence,
        });
        expect(pick?.model).toBe('gemma4-e4b-q4');
      }
    });
  });

  describe('gate-evidence demotion (never exclusion)', () => {
    const evidence =
      (map: Record<string, ModelGateEvidence>) => (provider: string, modelId: string) =>
        map[`${provider}:${modelId}`];

    it('repeated pauses demote a candidate behind its tier peers', () => {
      const pick = rankModelForFloor({
        floor: 'small',
        candidates: [
          candidate({ modelId: 'pausey-8b', tier: 'small', parameterSizeB: 8 }),
          candidate({ modelId: 'steady-9b', tier: 'small', parameterSizeB: 9 }),
        ],
        gateEvidence: evidence({
          'llama-cpp:pausey-8b': { attempts: 10, approves: 3, holds: 7, pauses: 2 },
        }),
      });
      expect(pick?.model).toBe('steady-9b');
    });

    it('many attempts with zero approvals demote', () => {
      const pick = rankModelForFloor({
        floor: 'small',
        candidates: [
          candidate({ modelId: 'flailing-8b', tier: 'small', parameterSizeB: 8 }),
          candidate({ modelId: 'steady-9b', tier: 'small', parameterSizeB: 9 }),
        ],
        gateEvidence: evidence({
          'llama-cpp:flailing-8b': { attempts: 6, approves: 0, holds: 6, pauses: 0 },
        }),
      });
      expect(pick?.model).toBe('steady-9b');
    });

    it('normal repair-loop holds do NOT demote (holds are not a signal)', () => {
      const pick = rankModelForFloor({
        floor: 'small',
        candidates: [
          candidate({ modelId: 'worker-8b', tier: 'small', parameterSizeB: 8 }),
          candidate({ modelId: 'other-9b', tier: 'small', parameterSizeB: 9 }),
        ],
        gateEvidence: evidence({
          'llama-cpp:worker-8b': { attempts: 10, approves: 5, holds: 5, pauses: 1 },
        }),
      });
      expect(pick?.model).toBe('worker-8b');
    });

    it('insufficient samples do not demote', () => {
      const pick = rankModelForFloor({
        floor: 'small',
        candidates: [
          candidate({ modelId: 'new-8b', tier: 'small', parameterSizeB: 8 }),
          candidate({ modelId: 'other-9b', tier: 'small', parameterSizeB: 9 }),
        ],
        gateEvidence: evidence({
          'llama-cpp:new-8b': { attempts: 3, approves: 0, holds: 3, pauses: 0 },
        }),
      });
      expect(pick?.model).toBe('new-8b');
    });

    it('the only clearing candidate is still picked even when demoted', () => {
      const pick = rankModelForFloor({
        floor: 'small',
        candidates: [candidate({ modelId: 'only-8b', tier: 'small', parameterSizeB: 8 })],
        gateEvidence: evidence({
          'llama-cpp:only-8b': { attempts: 12, approves: 0, holds: 12, pauses: 3 },
        }),
      });
      expect(pick?.model).toBe('only-8b');
      expect(pick?.reason).toContain('demoted-by-gate-history');
    });
  });
});

describe('fitnessLookupFromRecords', () => {
  it('maps resolved records into evidence keyed by provider:model', () => {
    const ok = { ok: true, detail: 'fine' };
    const record: ResolvedModelFitness = {
      record: {
        schemaVersion: 1,
        provider: 'llama-cpp',
        modelId: 'gemma4-e4b-q4',
        status: 'probed',
        admitted: true,
        genTokensPerSec: 24,
        createdAt: 'T',
        durationMs: 1,
        trigger: 'manual',
        host: { totalRamBytes: 1, gpuVramBytes: null, source: 't' },
        checks: {
          spawn: ok,
          toolRoundTrip: ok,
          throughput: ok,
          reasoningBudget: ok,
          contextFit: ok,
        },
      },
      stale: false,
      hardwareChanged: false,
    };
    const lookup = fitnessLookupFromRecords([record]);
    expect(lookup('llama-cpp', 'gemma4-e4b-q4')).toEqual({
      status: 'probed',
      admitted: true,
      genTokensPerSec: 24,
      stale: false,
    });
    expect(lookup('llama-cpp', 'unknown')).toBeUndefined();
  });
});

describe('modelRoutingDisabled', () => {
  it('reads GEZEL_DISABLE_MODEL_ROUTING=1', () => {
    expect(modelRoutingDisabled({})).toBe(false);
    expect(modelRoutingDisabled({ GEZEL_DISABLE_MODEL_ROUTING: '1' })).toBe(true);
    expect(modelRoutingDisabled({ GEZEL_DISABLE_MODEL_ROUTING: '0' })).toBe(false);
  });
});
