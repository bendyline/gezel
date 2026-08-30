import { describe, expect, it } from 'vitest';
import {
  SCORECARD_DATA_ATTRS,
  SCORECARD_QUERY_PARAMS,
  scorecardHardwareKey,
  scorecardHardwareLabel,
  scorecardModelFamilyId,
} from './filter.js';
import type { ScorecardDevice } from './schema.js';

const device = (over: Partial<ScorecardDevice> = {}): ScorecardDevice => ({
  label: 'Mac · Apple M4 Max',
  platform: 'darwin',
  arch: 'arm64',
  ...over,
});

describe('scorecardModelFamilyId', () => {
  it('drops the quantization so one model is one entry in the picker', () => {
    expect(scorecardModelFamilyId('gemma4-12b-q4')).toBe('gemma4-12b');
    expect(scorecardModelFamilyId('gemma4-12b-q8')).toBe('gemma4-12b');
    expect(scorecardModelFamilyId('qwen3.8-27b-q2')).toBe('qwen3.8-27b');
    expect(scorecardModelFamilyId('qwen3.8-27b-iq1-s')).toBe('qwen3.8-27b');
    expect(scorecardModelFamilyId('btl4-compact-iq2')).toBe('btl4-compact');
  });

  it('keeps a size or variant segment that is not a quantization', () => {
    // The MoE marker is part of the model's identity — merging it into
    // `qwen3.6-35b` would silently pool two different models into one row
    // group and publish their runs as if they were the same measurement.
    expect(scorecardModelFamilyId('qwen3.6-35b-a3b-q4')).toBe('qwen3.6-35b-a3b');
    expect(scorecardModelFamilyId('gemma4-e4b-q4')).toBe('gemma4-e4b');
    expect(scorecardModelFamilyId('deepseek-v4-flash-284b-q2')).toBe('deepseek-v4-flash-284b');
    expect(scorecardModelFamilyId('lfm2.5-2.6b-q4')).toBe('lfm2.5-2.6b');
  });

  it('leaves an id alone when nothing recognizable trails it', () => {
    expect(scorecardModelFamilyId('mistral-7b')).toBe('mistral-7b');
    expect(scorecardModelFamilyId('gpt-5')).toBe('gpt-5');
    expect(scorecardModelFamilyId('q4')).toBe('q4');
  });

  it('does not swallow a name segment that follows the quantization', () => {
    expect(scorecardModelFamilyId('someone-q4-instruct')).toBe('someone-q4-instruct');
  });
});

describe('scorecard hardware grouping', () => {
  it('names the three platforms a reader recognizes', () => {
    expect(scorecardHardwareLabel(device())).toBe('Mac');
    expect(scorecardHardwareLabel(device({ platform: 'win32' }))).toBe('Windows');
    expect(scorecardHardwareLabel(device({ platform: 'linux' }))).toBe('Linux');
    expect(scorecardHardwareKey(device())).toBe('mac');
    expect(scorecardHardwareKey(device({ platform: 'win32' }))).toBe('windows');
  });

  it('falls back to the raw platform rather than inventing a name', () => {
    const exotic = device({ platform: 'freebsd' });
    expect(scorecardHardwareLabel(exotic)).toBe('freebsd');
    expect(scorecardHardwareKey(exotic)).toBe('freebsd');
  });
});

describe('the shared vocabulary', () => {
  // The renderer stamps these and the site script reads them back. They are
  // constants precisely so a rename lands on both halves at once; a literal
  // on either side would fail as a filter that matches nothing, with no error
  // anywhere to say why.
  it('keeps every data attribute a `data-` attribute', () => {
    for (const [name, attr] of Object.entries(SCORECARD_DATA_ATTRS)) {
      expect(attr, name).toMatch(/^data-[a-z0-9-]+$/);
    }
  });

  it('keeps the query parameter names distinct', () => {
    const values = Object.values(SCORECARD_QUERY_PARAMS);
    expect(new Set(values).size).toBe(values.length);
  });
});
