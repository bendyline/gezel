import type { BenchCaseOutcome, BenchPackManifest } from '@bendyline/gezel/eval';
import { describe, expect, it } from 'vitest';
import { renderCasesIndex, renderTaskCasesPage, taskPageName } from './cases-page.ts';

const task = {
  id: 'illustration-svg',
  family: 'visuals',
  label: 'SVG illustrations',
  description: 'Draw it.',
  trials: 1,
  scoring: { checks: 0.3, judge: 0.7 },
  judge: null,
  cases: [{ id: 'water', label: 'The water cycle' }],
} as unknown as BenchPackManifest['tasks'][number];

function outcome(overrides: Partial<BenchCaseOutcome>): BenchCaseOutcome {
  return {
    schemaVersion: 1,
    packVersion: '0.2.1',
    taskId: 'illustration-svg',
    caseId: 'water',
    trial: 0,
    seed: 1,
    model: 'llama-cpp:m',
    contextWindow: 32768,
    usable: true,
    checks: [{ id: 'valid', label: 'A valid picture', score: 1, weight: 1 }],
    artifact: null,
    judgeInput: { rubricId: 'svg', context: 'Water <evaporates> & rains.' },
    calls: [{ promptTokens: 10, completionTokens: 300, finishReason: 'stop', ms: 1 }],
    error: null,
    notes: [],
    ms: 1500,
    ...overrides,
  };
}

describe('docbench case pages', () => {
  const page = renderTaskCasesPage({
    runId: 'round',
    task,
    models: [{ modelId: 'big', docbench: 80 }, { modelId: 'small' }],
    rows: [
      {
        modelId: 'small',
        outcome: outcome({
          usable: false,
          checks: [
            { id: 'valid', label: 'A valid picture', score: 0, weight: 1, detail: 'No <svg>' },
          ],
          artifact: { kind: 'text', content: '<script>alert(1)</script>' },
        }),
        judgement: null,
      },
      {
        modelId: 'big',
        outcome: outcome({
          artifact: { kind: 'svg', content: '<svg><script>alert(1)</script><circle r="4"/></svg>' },
        }),
        judgement: null,
      },
    ],
  });

  it('puts models in ranking order', () => {
    expect(page.indexOf('<b>big</b>')).toBeLessThan(page.indexOf('<b>small</b>'));
  });

  it('never lets model output run or break the page', () => {
    expect(page).not.toContain('<script>');
    expect(page).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    // Pictures render in an empty sandbox: no scripts, no network, no top navigation.
    expect(page).toMatch(/<iframe class="svg" sandbox="" [^>]*srcdoc="&lt;!doctype html&gt;/);
    expect(page).toContain('Water &lt;evaporates&gt; &amp; rains.');
  });

  it('says why an output scored zero', () => {
    expect(page).toContain('not usable');
    expect(page).toContain('A valid picture — No &lt;svg&gt;');
  });

  it('indexes every task with each model’s mean score', () => {
    const index = renderCasesIndex({
      runId: 'round',
      manifest: { version: '0.2.1', tasks: [task] } as unknown as BenchPackManifest,
      models: [{ modelId: 'big', docbench: 80.4 }, { modelId: 'small' }],
      taskScores: new Map([['illustration-svg', new Map([['big', { score: 0.7, judged: true }]])]]),
    });
    expect(index).toContain(`href="${taskPageName('illustration-svg')}"`);
    expect(index).toContain('<td class="score hi">70</td><td>–</td>');
  });
});
