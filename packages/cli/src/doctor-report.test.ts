import { SCORECARD } from '@bendyline/gezel';
import type { ModelFitnessEntry } from '@bendyline/gezel-client';
import { describe, expect, it } from 'vitest';
import {
  doctorVerdict,
  hardwareClassCoverage,
  renderDoctorModel,
  renderFitness,
} from './doctor-report.js';

const passed: ModelFitnessEntry = {
  key: 'llama-cpp:qwen3.8-27b-q4',
  record: {
    schemaVersion: 1,
    provider: 'llama-cpp',
    modelId: 'qwen3.8-27b-q4',
    status: 'probed',
    admitted: true,
    genTokensPerSec: 31.8,
    createdAt: '2026-10-28T09:00:00.000Z',
    durationMs: 40_000,
    trigger: 'install',
    host: { totalRamBytes: 64e9, gpuVramBytes: 32e9, source: 'gpu-vulkan' },
    checks: {
      spawn: { ok: true, detail: 'engine spawned and served the probe session' },
      toolRoundTrip: { ok: true, detail: 'called write_file with the marker' },
      throughput: { ok: true, detail: 'decodes at 31.8 t/s (floor 3 t/s)' },
      reasoningBudget: { ok: true, detail: 'bounded' },
      contextFit: { ok: true, detail: '65,536 tokens of context (floor 16,384)' },
    },
  },
  stale: false,
  hardwareChanged: false,
};

const device = { platform: 'win32', arch: 'x64', label: 'win32' };

describe('gezel doctor model report', () => {
  it('shows the fitness check and the published measurement side by side', () => {
    const lines = renderDoctorModel({
      provider: 'llama-cpp',
      modelId: 'qwen3.8-27b-q4',
      fitness: passed,
      probing: false,
      dataset: SCORECARD,
      device,
      rows: 2,
    });
    const text = lines.join('\n');
    expect(lines[0]).toBe('model: qwen3.8-27b-q4 (llama-cpp)');
    expect(text).toContain('fitness check: passed (31.8 tok/s, 2026-10-28)');
    expect(text).toContain('ok  answers a tool call');
    expect(text).toMatch(/measured: \d+% general \(.+\)/);
    expect(text).toContain('Full tables: https://gezel.com/docs/model-scorecard/');
    // Two published rows, each with its provenance stamp.
    expect(text.split('\n').filter((l) => /\bgezel \S+ · catalog/.test(l))).toHaveLength(2);
  });

  it('is honest about a stale, failed, or absent check and an unmeasured model', () => {
    expect(renderFitness(undefined, false)[0]).toContain('not run yet');
    expect(renderFitness(undefined, true)[0]).toBe('fitness check: running now');
    const failed: ModelFitnessEntry = {
      ...passed,
      stale: true,
      record: {
        ...passed.record,
        admitted: false,
        checks: {
          ...passed.record.checks,
          throughput: { ok: false, detail: 'decodes at 1.2 t/s — below the 3 t/s floor' },
        },
      },
    };
    const text = renderFitness(failed, false).join('\n');
    expect(text).toContain('fitness check: FAILED (the model changed since; treat as not run');
    expect(text).toContain('NO  decodes fast enough');
    const unmeasured = renderDoctorModel({
      provider: 'llama-cpp',
      modelId: 'no-such-model-q4',
      fitness: undefined,
      probing: false,
      dataset: SCORECARD,
      device,
    }).join('\n');
    expect(unmeasured).toContain('not measured in a published round');
    expect(unmeasured).toContain('`gezel bench`');
  });

  it("says whether this machine's hardware class has published results", () => {
    const mac = { platform: 'darwin', arch: 'arm64', label: 'Mac' };
    expect(hardwareClassCoverage(SCORECARD, 'qwen3.8-27b-q4', mac)).toMatch(
      /^ {2}on Mac: \d+ published rounds; \d+ results? for this model$/,
    );
    expect(hardwareClassCoverage(SCORECARD, 'no-such-model-q4', mac)).toMatch(
      /on Mac: \d+ published rounds?, none with this model — `gezel bench` measures it here/,
    );
    expect(
      hardwareClassCoverage(SCORECARD, 'qwen3.8-27b-q4', {
        platform: 'freebsd',
        arch: 'x64',
        label: 'FreeBSD',
      }),
    ).toBe(
      '  on freebsd: no published scorecard round has run on freebsd yet — `gezel bench` would be the first',
    );
  });

  it('ends with the next command to run', () => {
    expect(
      doctorVerdict({
        nodeOk: false,
        serviceReachable: false,
        modelId: undefined,
        fitnessAdmitted: null,
      }),
    ).toContain('Node.js 24');
    expect(
      doctorVerdict({
        nodeOk: true,
        serviceReachable: false,
        modelId: undefined,
        fitnessAdmitted: null,
      }),
    ).toContain('`gezel start`');
    expect(
      doctorVerdict({
        nodeOk: true,
        serviceReachable: true,
        modelId: undefined,
        fitnessAdmitted: null,
      }),
    ).toContain('gezel model pull');
    expect(
      doctorVerdict({ nodeOk: true, serviceReachable: true, modelId: 'm', fitnessAdmitted: false }),
    ).toContain('failed its fitness check');
    expect(
      doctorVerdict({ nodeOk: true, serviceReachable: true, modelId: 'm', fitnessAdmitted: true }),
    ).toBe(
      'Verdict: ready. m is installed and passed its fitness check; `gezel run "hello"` to talk to it, `gezel bench` to measure it.',
    );
  });
});
