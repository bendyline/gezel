import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '@bendyline/gezel';
import { afterEach, describe, expect, it } from 'vitest';
import { contractScopedSpec } from '../craftbooks/scenario.ts';
import type { CraftbookEvalSpec } from '../craftbooks/types.ts';
import { armOrder, parseStrategyArms } from './books.ts';
import { gradeContract } from './contract-grade.ts';
import { clusterBootstrap, compareArms } from './summary.ts';

const contract = {
  goal: 'A cited summary of the brief.',
  deliverables: [
    { id: 'summary', path: 'out/summary.md', kind: 'markdown-report', description: 'The summary' },
  ],
  criteria: [
    {
      id: 'long-enough',
      kind: 'acceptance',
      text: 'The summary is substantial',
      checks: [{ kind: 'minBytes', file: 'out/summary.md', bytes: 40 }],
    },
    {
      id: 'grounded',
      kind: 'quality',
      enforce: 'eval-only',
      text: 'Every figure is in the brief',
      checks: [{ kind: 'claimsGrounded', file: 'out/summary.md' }],
    },
    { id: 'tone', kind: 'quality', enforce: 'advisory', text: 'Reads well' },
  ],
};

const task = {
  projectId: 'p',
  num: 1,
  ref: 'p/1',
  title: 'Summarize',
  status: 'complete',
  strategy: 'outcome',
  assignee: { kind: 'gezel', gezelId: 'w' },
  activeStepId: 'outcome',
  sourceCraftbookIds: [{ role: 'main', catalogId: 'summarize' }],
  craftbook: {
    id: 'summarize',
    name: 'Summarize',
    entryStepId: 'outcome',
    renderedAs: 'outcome',
    contract,
    steps: [{ id: 'outcome', name: 'Deliver the outcome', terminal: true, createdAt: 't' }],
    sourceSteps: [
      {
        id: 'scope',
        name: 'Scope',
        advanceWhen: { file: 'out/scope.md' },
        createdAt: 't',
      },
      {
        id: 'notes',
        name: 'Notes',
        advanceWhen: { file: 'tasks/1/notes.md', artifact: true },
        createdAt: 't',
      },
      {
        id: 'write',
        name: 'Write',
        advanceWhen: { file: 'out/summary.md' },
        gate: {
          at: 'completion',
          checks: [{ kind: 'minBytes', file: 'out/summary.md', bytes: 40 }],
        },
        createdAt: 't',
      },
    ],
    createdAt: 't',
    updatedAt: 't',
  },
  createdAt: '2026-10-22T10:00:00.000Z',
  updatedAt: '2026-10-22T10:30:00.000Z',
} as unknown as Task;

describe('strategy arms', () => {
  it('rotates the arm order each replicate', () => {
    const arms = parseStrategyArms('stepwise,generalist,outcome');
    expect(armOrder(arms, 0).map((a) => a.arm)).toEqual(['stepwise', 'generalist', 'outcome']);
    expect(armOrder(arms, 1).map((a) => a.arm)).toEqual(['generalist', 'outcome', 'stepwise']);
    expect(() => parseStrategyArms('commando')).toThrow(/unknown arm/);
  });
});

describe('contractScopedSpec', () => {
  it("drops the recipe's process files and keeps result checks", () => {
    const spec = {
      success: {
        summary: 's',
        deliverables: [
          { path: 'out/scope.md', kind: 'markdown-doc' },
          { path: '{{task.dir}}/notes.md', kind: 'markdown-doc' },
          { path: 'out/summary.md', kind: 'markdown-report' },
        ],
        checks: [
          { kind: 'nodeScriptPasses', script: 'tests/verify.mjs' },
          { kind: 'contains', file: 'out/scope.md', pattern: 'x' },
        ],
        taskNotes: { minBytes: 10 },
      },
    } as unknown as CraftbookEvalSpec;
    const scoped = contractScopedSpec(spec, task);
    expect(scoped.spec.success.deliverables?.map((d) => d.path)).toEqual(['out/summary.md']);
    expect(scoped.spec.success.checks?.map((c) => c.kind)).toEqual(['nodeScriptPasses']);
    expect(scoped.spec.success.taskNotes).toBeUndefined();
    expect(scoped.dropped).toEqual(['out/scope.md', '{{task.dir}}/notes.md', 'task notes']);
  });

  it('drops checks against an outline, required tool calls and History evidence', () => {
    const spec = {
      success: {
        summary: 's',
        deliverables: [
          {
            path: 'out/summary.md',
            kind: 'markdown-report',
            checks: [
              {
                kind: 'markdownHeadingsMatch',
                file: 'out/summary.md',
                outlineFile: 'out/scope.md',
              },
              {
                kind: 'valueGrounding',
                file: 'out/summary.md',
                sourceFiles: ['source/brief.md'],
              },
            ],
          },
        ],
        mocks: [{ service: 'docblocks', requiredTools: ['preview_document'], minRequests: 1 }],
        history: [{ kind: 'tool.called', summaryPattern: 'preview' }],
      },
    } as unknown as CraftbookEvalSpec;
    const scoped = contractScopedSpec(spec, task);
    expect(scoped.spec.success.deliverables?.[0]?.checks?.map((c) => c.kind)).toEqual([
      'valueGrounding',
    ]);
    expect(scoped.spec.success.mocks).toEqual([{ service: 'docblocks', minRequests: 1 }]);
    expect(scoped.spec.success.history).toBeUndefined();
    expect(scoped.dropped).toEqual([
      'out/scope.md',
      'required tool calls (preview_document)',
      'History evidence (tool.called)',
    ]);
  });
});

describe('gradeContract', () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('grades a finished trial from its directory, eval-only criteria included', async () => {
    dir = await mkdtemp(join(tmpdir(), 'gezel-strategy-grade-'));
    await writeFile(join(dir, 'state.json'), JSON.stringify({ tasks: { tasks: [task] } }));
    await mkdir(join(dir, 'workspace', 'p', 'out'), { recursive: true });
    await mkdir(join(dir, 'workspace', 'p', 'source'), { recursive: true });
    await writeFile(
      join(dir, 'workspace', 'p', 'source', 'brief.md'),
      'The pilot covered 18 SKUs.',
    );
    await writeFile(
      join(dir, 'workspace', 'p', 'out', 'summary.md'),
      'The pilot covered 18 SKUs (source: source/brief.md). It covered 30 stores.',
    );
    const grade = await gradeContract(dir, 'summarize');
    expect(grade?.strategy).toBe('outcome');
    expect(grade?.criteria.map((c) => [c.id, c.pass])).toEqual([
      ['long-enough', true],
      ['grounded', false],
      ['tone', null],
    ]);
    expect(grade?.acceptancePassed).toBe(true);
    expect(grade?.score).toBe(0.5);
  });
});

describe('analysis', () => {
  it('bootstraps over books, not trials', () => {
    const rows = [
      { book: 'a', d: 1 },
      { book: 'a', d: 1 },
      { book: 'b', d: -1 },
    ];
    const interval = clusterBootstrap(
      rows,
      (r) => r.book,
      (s) => s.reduce((n, r) => n + r.d, 0) / s.length,
      { iterations: 500 },
    );
    expect(interval?.estimate).toBeCloseTo(1 / 3);
    expect(interval?.low).toBeLessThan(0);
    expect(interval?.high).toBeGreaterThan(0);
  });

  it('pairs each arm with the stepwise control by book and replicate', () => {
    const row = (arm: string, book: string, p1: boolean, p2: number, durationMs: number) => ({
      modelId: 'm',
      craftbookId: book,
      bookClass: 'x',
      arm,
      trialId: `${arm}-${book}`,
      trialDir: '',
      testPass: p1,
      testScore: null,
      testMax: null,
      contract: null,
      p1,
      p2,
      p3: null,
      durationMs,
    });
    const [comparison] = compareArms(
      [
        row('stepwise', 'a', true, 1, 100),
        row('outcome', 'a', false, 0.5, 50),
        row('stepwise', 'b', false, 0.5, 100),
        row('outcome', 'b', true, 1, 50),
      ],
      ['stepwise', 'outcome'],
    );
    expect(comparison?.pairs).toBe(2);
    expect(comparison?.p1).toMatchObject({ armOnly: 1, controlOnly: 1 });
    expect(comparison?.wallRatio).toBe(0.5);
    expect(comparison?.p2Delta?.estimate).toBe(0);
  });
});

describe('judge validity', () => {
  const bundle = {
    request: 'Write a cited readout.',
    goal: 'A readout.',
    bar: [],
    deliverables: [
      {
        label: 'Deliverable 1 (markdown-report): the readout',
        kind: 'markdown-report',
        text: '# Readout\n\nThe pilot covered 18 SKUs and cut errors by 14.2% [1].\n\n## Next\n\n- Train 2 teams\n- Ship it\n\n## Sources\n\n1. source/brief.md',
      },
      { label: 'Deliverable 2 (json): numbers', kind: 'json', text: '{"skus": 18}' },
    ],
    sources: [{ label: 'source/brief.md', text: 'The pilot covered 18 SKUs; errors fell 14.2%.' }],
  };

  it('plants each defect in the prose deliverable only', async () => {
    const { plantDefect, falsifiedFigure } = await import('./judge-validity.ts');
    expect(falsifiedFigure('14.2%')).toBe('19.5%');
    expect(falsifiedFigure('18')).toBe('25');
    expect(falsifiedFigure('1,200')).toBe('1,644');
    const falsified = plantDefect(bundle, 'falsified-figures')!;
    expect(falsified.deliverables[0]!.text).toContain('25 SKUs');
    expect(falsified.deliverables[0]!.text).toContain('19.5% [1]');
    expect(falsified.deliverables[1]!.text).toBe('{"skus": 18}');
    const fabricated = plantDefect(bundle, 'fabricated-claim')!.deliverables[0]!.text;
    expect(fabricated.split('\n\n')[2]).toMatch(
      /^A follow-up review .*\(source: source\/brief\.md\)\.$/,
    );
    expect(plantDefect(bundle, 'truncated')!.deliverables[0]!.text).not.toContain('Sources');
    expect(plantDefect(bundle, 'flattened')!.deliverables[0]!.text).not.toContain('\n');
    const code = {
      ...bundle,
      deliverables: [{ label: 'code', kind: 'code-module', text: 'a\nb\nc\nd\ne' }],
    };
    expect(plantDefect(code, 'flattened')).toBeNull();
    expect(plantDefect(code, 'truncated')!.deliverables[0]!.text).toBe('a\nb\nc');
  });

  it('computes interval alpha and a stable quarter for the second judge', async () => {
    const { krippendorffAlphaInterval, secondJudgeSample } = await import('./judge-validity.ts');
    expect(
      krippendorffAlphaInterval([
        [1, 1],
        [2, 2],
        [3, 3],
      ]),
    ).toBe(1);
    expect(
      krippendorffAlphaInterval([
        [1, 2],
        [2, 1],
      ]),
    ).toBeCloseTo(-0.5);
    expect(krippendorffAlphaInterval([[4]])).toBeNull();
    const ids = Array.from({ length: 9 }, (_, i) => `t${i}`);
    const picked = secondJudgeSample(ids);
    expect(picked.size).toBe(3);
    expect(secondJudgeSample([...ids].reverse())).toEqual(picked);
  });
});

describe('judge', () => {
  it('blinds the run’s mechanics and reads the CLI’s structured result', async () => {
    const { blind, isCurrentJudgeReport, judgeBundle, parseJudgeOutput, summarizeSamples } =
      await import('./judge.ts');
    // A report from an older prompt is never read back as a score.
    const empty = { request: '', goal: '', bar: [], deliverables: [], sources: [] };
    const scored = {
      ...judgeBundle(empty, { samples: 0 }),
      samples: [{ scores: { fitness: 8, completeness: 8, grounding: 8, craft: 8 }, reasons: '' }],
    };
    expect(isCurrentJudgeReport(scored)).toBe(true);
    expect(isCurrentJudgeReport({ ...scored, promptVersion: undefined })).toBe(false);
    expect(isCurrentJudgeReport({ ...scored, samples: [] })).toBe(false);
    expect(blind('See tasks/12/report.md.')).toBe('See work/report.md.');
    expect(blind('Cited: source/pilot-scope.md, the next step is review.md')).toBe(
      'Cited: source/pilot-scope.md, the next step is review.md',
    );
    const sample = parseJudgeOutput(
      JSON.stringify({
        structured_output: { fitness: 8, completeness: 6, grounding: 9, craft: 7, reasons: 'ok' },
      }),
    );
    expect(sample.scores.grounding).toBe(9);
    expect(() =>
      parseJudgeOutput(JSON.stringify({ is_error: true, result: 'API Error: 400' })),
    ).toThrow(/judge call failed/);
    const summary = summarizeSamples([
      sample,
      { ...sample, scores: { ...sample.scores, craft: 9 } },
    ]);
    expect(summary.axes.craft).toBe(8);
    expect(summary.mean).toBeCloseTo(7.75);
  });
});
