import { describe, expect, it } from 'vitest';
import { COMMUNITY_SCORECARD, SCORECARD, communityDataset } from './index.js';
import { measuredClaim, measuredResultFor, measuredRowsFor, measuredWhere } from './lookup.js';

describe('measuredResultFor', () => {
  it('prefers the newest headline result on the same platform', () => {
    const mac = measuredResultFor(SCORECARD, 'qwen3.8-27b-q4', {
      platform: 'darwin',
      arch: 'arm64',
      label: 'Mac',
    });
    expect(mac?.sameHardwareClass).toBe(true);
    expect(mac?.result.suiteId).toBe('core');
    expect(mac?.run.provenance.device.platform).toBe('darwin');
    expect(mac?.run.scope).not.toBe('subset');
    expect(measuredClaim(mac)).toBe('100% general (M5 Max)');

    const linux = measuredResultFor(SCORECARD, 'qwen3.8-27b-q4', {
      platform: 'linux',
      arch: 'arm64',
      label: 'linux',
    });
    expect(measuredClaim(linux)).toBe('100% general (NVIDIA GB10)');
  });

  it('falls back to another platform rather than saying nothing, and names it', () => {
    const measured = measuredResultFor(SCORECARD, 'gemma4-e2b-q4', {
      platform: 'win32',
      arch: 'x64',
      label: 'Windows',
    });
    expect(measured?.sameHardwareClass).toBe(false);
    expect(measuredClaim(measured)).toBe('42% general (M5 Max)');
  });

  it('says not measured for a model no round has run', () => {
    expect(measuredResultFor(SCORECARD, 'no-such-model-q4')).toBeNull();
    expect(measuredClaim(null)).toBe('not measured');
  });

  it('lists every published row for a model, newest first, subsets included', () => {
    const rows = measuredRowsFor(SCORECARD, 'qwen3.8-27b-q4');
    expect(rows.length).toBeGreaterThan(10);
    const dates = rows.map((r) => r.run.provenance.startedAt);
    expect([...dates].sort((a, b) => b.localeCompare(a))).toEqual(dates);
    expect(rows.some((r) => r.run.scope === 'subset')).toBe(true);
  });

  it('shortens hardware to what fits a column', () => {
    expect(
      measuredWhere({
        label: 'x',
        platform: 'win32',
        arch: 'x64',
        cpuModel: 'AMD Ryzen 9 7950X3D 16-Core Processor',
        gpuModel: 'AMD Radeon AI PRO R9700',
      }),
    ).toBe('AMD Radeon AI PRO R9700');
    expect(
      measuredWhere({
        label: 'x',
        platform: 'win32',
        arch: 'x64',
        cpuModel: 'AMD Ryzen 9 7950X3D 16-Core Processor',
      }),
    ).toBe('AMD Ryzen 9 7950X3D');
    expect(
      measuredWhere({
        label: 'x',
        platform: 'darwin',
        arch: 'arm64',
        cpuModel: 'Apple M5 Max',
        gpuModel: 'Apple M5 Max (integrated GPU)',
      }),
    ).toBe('M5 Max');
  });
});

describe('community rounds', () => {
  it('are kept apart from the published scorecard', () => {
    const published = new Set(SCORECARD.runs.map((run) => run.id));
    expect(COMMUNITY_SCORECARD.runs.some((run) => published.has(run.id))).toBe(false);
  });

  it('may not reuse a published run id', () => {
    const run = SCORECARD.runs[0]!;
    const shard = { schemaVersion: 1, runs: [run], results: [] };
    expect(() => communityDataset([shard], SCORECARD)).toThrow(/reuses a published run id/);
    expect(communityDataset([], SCORECARD).runs).toEqual([]);
  });
});
