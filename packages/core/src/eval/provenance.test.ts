import { describe, expect, it } from 'vitest';
import { ScorecardDatasetSchema } from '../scorecard/schema.js';
import {
  EVAL_SUBSET_NOTE,
  describeEvalHost,
  describeEvalRun,
  evalDeviceFromHost,
  evalEngineBuilds,
  evalRunId,
  evalRunProvenance,
  evalShard,
  evalSuiteResult,
  isSuiteSubset,
  medianDecodeTokensPerSec,
  smokeSuiteIdFor,
} from './provenance.js';
import type { EvalCatalogSuite, EvalTrialSummary } from './schemas.js';

const host = {
  version: '1.2.11',
  runtime: { platform: 'linux', arch: 'x64', osRelease: '6.8.0' },
  hardware: { totalRamBytes: 64 * 1024 ** 3, gpuDevices: [{ name: 'AMD Radeon AI PRO R9700' }] },
  engine: { nativeRelease: '0.1.54', llamaCppBackend: 'vulkan', llamaCppRevision: 'b7123' },
};

const suite: EvalCatalogSuite = {
  id: 'smoke',
  description: 'Fast pulse check. Not a scorecard — use core for that.',
  scenarioIds: ['tictactoe', 'tool-routing-image', 'symptom-debug'],
  authoredCeilingMs: 3 * 60 * 60_000,
};

let seq = 0;
function trial(overrides: Partial<EvalTrialSummary>): EvalTrialSummary {
  seq += 1;
  return {
    trialId: `t-${seq}`,
    scenarioId: 'tictactoe',
    modelId: 'qwen3.5-4b-q4',
    provider: 'llama-cpp',
    jobId: 'job-1',
    startedAt: `2026-11-01T10:${String(seq).padStart(2, '0')}:00.000Z`,
    running: false,
    success: true,
    failureClass: 'pass',
    modelTier: 'small',
    decodeTokensPerSec: 40,
    runDir: `/runs/t-${seq}`,
    ...overrides,
  };
}

describe('eval provenance', () => {
  it('turns host diagnostics into a device and a one-line stamp', () => {
    const device = evalDeviceFromHost(host, 'AMD Ryzen 9 7950X3D');
    expect(device).toMatchObject({
      platform: 'linux',
      arch: 'x64',
      memoryGb: 64,
      cpuModel: 'AMD Ryzen 9 7950X3D',
      gpuModel: 'AMD Radeon AI PRO R9700',
      osRelease: 'linux 6.8.0',
    });
    expect(describeEvalHost(host, 'AMD Ryzen 9 7950X3D')).toBe(
      'AMD Ryzen 9 7950X3D · AMD Radeon AI PRO R9700 · 64 GB · native 0.1.54 (vulkan) · gezel 1.2.11',
    );
    expect(evalEngineBuilds(host)).toEqual({
      native: '0.1.54',
      'llama-cpp': 'b7123',
      'llama-cpp-backend': 'vulkan',
    });
  });

  it('finds the smoke variant of a suite only when the catalog ships one', () => {
    const catalog = { suites: [suite, { ...suite, id: 'developer-smoke' }] };
    expect(smokeSuiteIdFor('core', catalog)).toBe('smoke');
    expect(smokeSuiteIdFor('developer', catalog)).toBe('developer-smoke');
    expect(smokeSuiteIdFor('productivity', catalog)).toBeNull();
  });

  it('calls anything short of the whole suite a subset, with the shared note', () => {
    expect(isSuiteSubset(suite, suite.scenarioIds)).toBe(false);
    expect(isSuiteSubset(suite, ['tictactoe'])).toBe(true);
    expect(EVAL_SUBSET_NOTE).toMatch(/not a suite score/);
  });

  it('builds a dataset shard the published scorecard tooling accepts', () => {
    const device = evalDeviceFromHost(host, 'AMD Ryzen 9 7950X3D');
    const startedAt = '2026-11-01T10:00:00.000Z';
    const run = evalRunProvenance({
      id: evalRunId(startedAt, device, 'qwen3.5-4b-q4'),
      startedAt,
      device,
      gezelVersion: '1.2.11',
      gildeVersion: '0.3.4',
      count: 3,
      engineBuilds: evalEngineBuilds(host),
      scenariosBySuite: { smoke: suite.scenarioIds },
      subset: false,
    });
    expect(run.id).toBe('2026-11-01-amd-ryzen-9-7950x3d-qwen3-5-4b-q4');
    const trials = [
      trial({}),
      trial({}),
      trial({ success: false, failureClass: 'model' }),
      trial({ scenarioId: 'symptom-debug' }),
      trial({ scenarioId: 'symptom-debug', success: false, failureClass: 'infra' }),
      trial({ scenarioId: 'symptom-debug', running: true, success: undefined }),
    ];
    const result = evalSuiteResult({
      run,
      suite,
      target: { provider: 'llama-cpp', modelId: 'qwen3.5-4b-q4', label: 'Qwen 3.5 (4B, Q4)' },
      trials,
    });
    expect(result.cells).toEqual([
      { scenarioId: 'tictactoe', trials: 3, successes: 2, nonModelFailures: 0 },
      { scenarioId: 'tool-routing-image', trials: 0, successes: 0, nonModelFailures: 0 },
      // The infra failure stays out of the model's denominator; the running
      // trial is not a result yet.
      { scenarioId: 'symptom-debug', trials: 2, successes: 1, nonModelFailures: 1 },
    ]);
    expect(result.tier).toBe('small');
    const shard = evalShard(run, [result]);
    expect(ScorecardDatasetSchema.safeParse(shard).success).toBe(true);
    expect(describeEvalRun(run, ['llama-cpp'])).toBe(
      'AMD Ryzen 9 7950X3D · AMD Radeon AI PRO R9700 · 64 GB · llama-cpp · 3 trials per task · 2026-11-01 · gezel 1.2.11 · catalog 0.3.4',
    );
    expect(medianDecodeTokensPerSec(trials)).toBe(40);
    expect(medianDecodeTokensPerSec([])).toBeNull();
  });

  it('marks a partial suite as a subset in the run record', () => {
    const device = evalDeviceFromHost(host);
    const run = evalRunProvenance({
      id: 'r',
      startedAt: '2026-11-01T10:00:00.000Z',
      device,
      gezelVersion: '1.2.11',
      gildeVersion: 'unknown',
      count: 1,
      scenariosBySuite: { smoke: ['tictactoe'] },
      subset: true,
    });
    expect(run.scope).toBe('subset');
    expect(describeEvalRun(run)).toContain('focused subset');
    expect(device.label).toBe('Linux');
  });
});
