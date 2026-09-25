import { describe, expect, it } from 'vitest';
import { modelLabel, trialsPerCellText } from './enrich-postmortems.ts';

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

describe('trialsPerCellText', () => {
  const entry = (modelId: string, scenarioId: string, mode?: string) =>
    ({ facts: { modelId, scenarioId, continuity: mode ? { mode } : undefined } }) as never;

  it('is a single number when every cell has the same trial count', () => {
    expect(trialsPerCellText([entry('opus', 'a', 'on'), entry('opus', 'a', 'off')])).toBe('1');
  });

  it('is a range when a rates root repeats some cells', () => {
    expect(
      trialsPerCellText([
        entry('gemma', 'a', 'on'),
        entry('gemma', 'a', 'on'),
        entry('gemma', 'b', 'on'),
      ]),
    ).toBe('1 to 2');
  });
});
