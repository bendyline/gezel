import { describe, expect, it } from 'vitest';
import { composeFitnessBadge } from './fitness-badge.js';
import type { ModelFitResult } from './model-fit.js';
import type { ModelFitnessRecord } from './schemas/model-fitness.js';

const okCheck = { ok: true, detail: 'fine' };

function record(overrides: Partial<ModelFitnessRecord> = {}): ModelFitnessRecord {
  return {
    schemaVersion: 1,
    provider: 'llama-cpp',
    modelId: 'gemma4-e4b-q8',
    status: 'probed',
    admitted: true,
    genTokensPerSec: 24.3,
    createdAt: '2026-07-07T00:00:00.000Z',
    durationMs: 45_000,
    trigger: 'manual',
    host: { totalRamBytes: 128 * 1024 ** 3, gpuVramBytes: null, source: 'test' },
    checks: {
      spawn: okCheck,
      toolRoundTrip: okCheck,
      throughput: okCheck,
      reasoningBudget: okCheck,
      contextFit: okCheck,
    },
    ...overrides,
  };
}

const fresh = (r: ModelFitnessRecord) => ({ record: r, stale: false, hardwareChanged: false });

describe('composeFitnessBadge', () => {
  it('probing wins over everything', () => {
    const b = composeFitnessBadge({ fitness: fresh(record()), probing: true });
    expect(b.tier).toBe('probing');
    expect(b.label).toBe('checking fitness…');
  });

  it('no record → unknown / not checked yet', () => {
    const b = composeFitnessBadge({});
    expect(b.tier).toBe('unknown');
    expect(b.label).toBe('not checked yet');
  });

  it('stale record → unknown with a re-run nudge', () => {
    const b = composeFitnessBadge({
      fitness: { record: record(), stale: true, hardwareChanged: false },
    });
    expect(b.tier).toBe('unknown');
    expect(b.detail).toMatch(/changed since/);
  });

  it('fresh admitted → ok with rounded t/s in the label', () => {
    const b = composeFitnessBadge({ fitness: fresh(record()) });
    expect(b.tier).toBe('ok');
    expect(b.label).toBe('proeve passed · 24 t/s');
  });

  it('fresh admitted without a measured t/s → plain pass label', () => {
    const b = composeFitnessBadge({ fitness: fresh(record({ genTokensPerSec: null })) });
    expect(b.label).toBe('proeve passed');
  });

  it.each([
    ['spawn', 'did not start'],
    ['toolRoundTrip', 'tool calls failed'],
    ['throughput', 'slow decoding'],
    ['reasoningBudget', 'unbounded reasoning'],
    ['contextFit', 'small context'],
  ] as const)('first failing axis names the warn label: %s → %s', (key, label) => {
    const r = record({ admitted: false });
    r.checks[key] = { ok: false, detail: `${key} went wrong` };
    const b = composeFitnessBadge({ fitness: fresh(r) });
    expect(b.tier).toBe('warn');
    expect(b.label).toBe(label);
    expect(b.detail).toContain(`${key} went wrong`);
  });

  it('spawn failure outranks later failing axes', () => {
    const r = record({ admitted: false });
    r.checks.spawn = { ok: false, detail: 'engine never came up' };
    r.checks.throughput = { ok: false, detail: 'also slow' };
    const b = composeFitnessBadge({ fitness: fresh(r) });
    expect(b.label).toBe('did not start');
    expect(b.detail).toContain('engine never came up');
    expect(b.detail).toContain('also slow');
  });

  it('status failed → warn "fitness check failed"', () => {
    const r = record({ status: 'failed', admitted: false });
    r.checks.spawn = { ok: false, detail: 'probe timed out' };
    const b = composeFitnessBadge({ fitness: fresh(r) });
    expect(b.tier).toBe('warn');
    expect(b.label).toBe('fitness check failed');
    expect(b.detail).toContain('probe timed out');
  });

  it('status deferred → unknown with a manual-run nudge', () => {
    const b = composeFitnessBadge({
      fitness: fresh(record({ status: 'deferred', admitted: false })),
    });
    expect(b.tier).toBe('unknown');
    expect(b.label).toBe('check deferred');
  });

  it('hardware drift softens the tooltip without changing the tier', () => {
    const b = composeFitnessBadge({
      fitness: { record: record(), stale: false, hardwareChanged: true },
    });
    expect(b.tier).toBe('ok');
    expect(b.detail).toMatch(/Hardware has changed/);
  });

  it('a worse RAM tier shows through in the detail on every state', () => {
    const tight: ModelFitResult = {
      tier: 'tight',
      label: 'may run slowly',
      detail: 'Exceeds the fast memory budget.',
      runnable: true,
    };
    for (const input of [
      { ramFit: tight },
      { ramFit: tight, fitness: fresh(record()) },
      { ramFit: tight, fitness: fresh(record({ admitted: false })) },
    ]) {
      expect(composeFitnessBadge(input).detail).toContain('may run slowly');
    }
    const fits: ModelFitResult = { tier: 'fits', label: 'fits', detail: 'x', runnable: true };
    expect(composeFitnessBadge({ ramFit: fits, fitness: fresh(record()) }).detail).not.toContain(
      'Memory fit',
    );
  });
});
