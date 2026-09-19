import { describe, expect, it } from 'vitest';
import { modelLabel } from './enrich-postmortems.ts';

describe('modelLabel', () => {
  it('is the bare model id when the trial carries no generalist-mode arm', () => {
    expect(modelLabel({ facts: { modelId: 'gemma4-12b-q4' } })).toBe('gemma4-12b-q4');
    expect(modelLabel({ facts: { modelId: 'opus', continuity: { mode: null } } })).toBe('opus');
  });

  it('names the arm so an A/B root yields two comparable rows per model', () => {
    expect(modelLabel({ facts: { modelId: 'opus', continuity: { mode: 'on' } } })).toBe(
      'opus (generalist)',
    );
    expect(modelLabel({ facts: { modelId: 'opus', continuity: { mode: 'off' } } })).toBe(
      'opus (stepwise)',
    );
    expect(modelLabel({ facts: { modelId: 'opus', continuity: { mode: 'auto' } } })).toBe(
      'opus (auto)',
    );
  });
});
