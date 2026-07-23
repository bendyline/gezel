import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bandColor, findTrial, formatBytes, formatDuration, modelColor } from './format.ts';

describe('eval viewer data formatting', () => {
  it('formats durations at each display boundary', () => {
    assert.equal(formatDuration(null), '—');
    assert.equal(formatDuration(0), '0s');
    assert.equal(formatDuration(59_400), '59s');
    assert.equal(formatDuration(60_000), '1m 0s');
    assert.equal(formatDuration(3_661_000), '1h 1m');
  });

  it('formats byte counts at each unit boundary', () => {
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(1536), '1.5 KB');
    assert.equal(formatBytes(1_572_864), '1.5 MB');
  });

  it('finds a trial by its stable id', () => {
    const trial = { trialId: 'trial-1' };
    const runs = { trials: [trial] };
    assert.equal(findTrial(runs, 'trial-1'), trial);
    assert.equal(findTrial(runs, 'missing'), undefined);
  });

  it('maps current and historical score bands to theme tokens', () => {
    assert.equal(bandColor('ship-ready'), 'var(--band-ship)');
    assert.equal(bandColor('needs-tuning'), 'var(--band-cap)');
    assert.equal(bandColor('capability-bound'), 'var(--band-cap)');
    assert.equal(bandColor('framework-gap'), 'var(--band-sys)');
    assert.equal(bandColor('systemic-issue'), 'var(--band-sys)');
    assert.equal(bandColor(null), 'var(--band-none)');
  });

  it('assigns deterministic model colors and a neutral missing color', () => {
    assert.equal(modelColor('local/model-a'), modelColor('local/model-a'));
    assert.equal(modelColor(null), '#888');
  });
});
