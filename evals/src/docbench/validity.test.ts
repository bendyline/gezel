import type { BenchCaseOutcome } from '@bendyline/gezel/eval';
import { describe, expect, it } from 'vitest';
import { plantDefect, stableSample } from './validity.ts';

function outcome(overrides: Partial<BenchCaseOutcome>): BenchCaseOutcome {
  return {
    schemaVersion: 1,
    packVersion: '0.2.0',
    taskId: 't',
    caseId: 'c',
    trial: 0,
    seed: 1,
    model: 'llama-cpp:m',
    contextWindow: 32768,
    usable: true,
    checks: [],
    artifact: null,
    judgeInput: {
      rubricId: 'r',
      context: 'The plant treats 4,800 cubic metres a day, 12% more than in 2019.',
    },
    calls: [],
    error: null,
    notes: [],
    ms: 1,
    ...overrides,
  };
}

const prose =
  'The plant treats 4,800 cubic metres a day. That is 12% more than in 2019, after the second ' +
  'filter bed opened. Every batch is tested for turbidity before it leaves the plant, and the ' +
  'results are posted weekly so residents can see them.';

describe('planted defects', () => {
  it('swaps every review finding for a non-finding about the same quote', () => {
    const review = outcome({
      judgeInput: {
        rubricId: 'review-matcher@2',
        context: 'doc',
        answerKey: [{ id: 'k', issue: 'x' }],
        items: [
          { id: 'f1', text: 'Quote: "Ravi finished the the load tests"\nMessage: Doubled word.' },
        ],
      },
    });
    const damaged = plantDefect(review, 'trivial-findings');
    expect(damaged?.judgeInput?.items?.[0]?.text).toContain(
      'Quote: "Ravi finished the the load tests"',
    );
    expect(damaged?.judgeInput?.items?.[0]?.text).toContain('This sentence is correct');
    expect(plantDefect(outcome({}), 'trivial-findings')).toBeNull();
  });

  it('cuts prose short, and closes a cut picture so it still parses', () => {
    const text = plantDefect(
      outcome({ artifact: { kind: 'markdown', content: prose } }),
      'truncated',
    );
    expect(text?.artifact?.content.length).toBeLessThan(prose.length / 2);
    const svg = `<svg viewBox="0 0 10 10">${'<rect x="1" y="1" width="2" height="2"/>'.repeat(10)}</svg>`;
    const cut = plantDefect(outcome({ artifact: { kind: 'svg', content: svg } }), 'truncated');
    expect(cut?.artifact?.content.endsWith('</svg>')).toBe(true);
    expect(cut?.artifact?.content).not.toMatch(/<[^>]*<\/svg>$/u);
  });

  it("cuts a diagram's spec, not just the diagram compiled from it", () => {
    const spec = JSON.stringify(
      {
        kind: 'timeline',
        events: Array.from({ length: 8 }, (_, i) => ({
          year: 2010 + i,
          label: `Event ${String(i)}`,
        })),
      },
      null,
      2,
    );
    const compiled = `\`\`\`timeline\n${'2010: Event\n'.repeat(60)}\`\`\``;
    const damaged = plantDefect(
      outcome({ artifact: { kind: 'text', content: `Spec:\n${spec}\n\nCompiled:\n${compiled}` } }),
      'truncated',
    );
    const content = damaged?.artifact?.content ?? '';
    expect(content).not.toContain('Compiled:');
    expect(content.length).toBeLessThan(spec.length / 2 + 10);
    expect(content.startsWith('Spec:\n{')).toBe(true);
  });

  it('changes only figures the source states', () => {
    const damaged = plantDefect(
      outcome({ artifact: { kind: 'markdown', content: prose } }),
      'invented-figures',
    );
    const content = damaged?.artifact?.content ?? '';
    expect(content).not.toContain('4,800');
    expect(content).not.toContain('12%');
    expect(content).not.toContain('2019');
    expect(
      plantDefect(
        outcome({ artifact: { kind: 'markdown', content: 'No figures here.' } }),
        'invented-figures',
      ),
    ).toBeNull();
  });

  it("removes a picture's labels", () => {
    const svg =
      '<svg viewBox="0 0 10 10"><circle r="3"/><text x="1" y="1">Evaporation</text></svg>';
    const damaged = plantDefect(
      outcome({ artifact: { kind: 'svg', content: svg } }),
      'unlabelled-picture',
    );
    expect(damaged?.artifact?.content).toBe('<svg viewBox="0 0 10 10"><circle r="3"/></svg>');
  });

  it('samples the same outputs however often the study runs', () => {
    const items = Array.from({ length: 40 }, (_, index) => ({
      key: `k${String(index).padStart(2, '0')}`,
    }));
    const first = stableSample([...items].reverse(), 8);
    expect(first).toHaveLength(8);
    expect(stableSample(items, 8)).toEqual(first);
    expect(stableSample(items.slice(0, 3), 8)).toHaveLength(3);
  });
});
