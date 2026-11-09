import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '@bendyline/gezel';
import { afterEach, describe, expect, it } from 'vitest';
import { contractScopedSpec } from '../craftbooks/scenario.ts';
import type { CraftbookEvalSpec } from '../craftbooks/types.ts';
import { armOrder, parseStrategyArms } from './books.ts';
import { gradeContract } from './contract-grade.ts';
import { parseEngineMetrics } from './engine-metrics.ts';
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

  // v2 read refactor-module's `./` as a file, showed "[missing]", and the
  // judge scored every code book 0 in every round.
  describe('a folder deliverable', () => {
    let dir: string;
    afterEach(async () => {
      if (dir) await rm(dir, { recursive: true, force: true });
    });

    it('shows the changed and added files, and the seed as sources', async () => {
      const { buildJudgeBundle, isCurrentJudgeReport, trialHasFolderDeliverable } = await import(
        './judge.ts'
      );
      const { loadCraftbookTestSpecsSync } = await import('../craftbooks/test-spec-loader.ts');
      const book = loadCraftbookTestSpecsSync().find((s) => s.craftbookId === 'refactor-module');
      const seed = (book?.spec.setup.files ?? []).filter((f) => f.path.endsWith('.js'));
      expect(seed.length).toBeGreaterThan(1);
      const [edited, untouched] = seed;
      const folderTask = {
        ...task,
        craftbook: {
          ...task.craftbook,
          id: 'refactor-module',
          version: book!.version,
          contract: {
            goal: 'Restructure the module without changing behavior.',
            deliverables: [
              {
                id: 'code',
                path: './',
                kind: 'code-module',
                description: 'The restructured source',
              },
            ],
            criteria: [],
          },
        },
      } as unknown as Task;
      dir = await mkdtemp(join(tmpdir(), 'gezel-strategy-judge-'));
      await writeFile(join(dir, 'state.json'), JSON.stringify({ tasks: { tasks: [folderTask] } }));
      const ws = join(dir, 'workspace', 'p');
      for (const f of seed) {
        await mkdir(join(ws, f.path, '..'), { recursive: true });
        await writeFile(join(ws, f.path), f.content);
      }
      await writeFile(join(ws, edited!.path), '// the delivered refactor\n');
      await mkdir(join(ws, 'src', 'lib'), { recursive: true });
      await writeFile(join(ws, 'src', 'lib', 'helper.js'), 'export const helper = 1;\n');
      await mkdir(join(ws, 'node_modules', 'dep'), { recursive: true });
      await writeFile(join(ws, 'node_modules', 'dep', 'index.js'), 'installed');
      await writeFile(join(ws, 'pnpm-lock.yaml'), 'lockfileVersion: 9');

      const bundle = await buildJudgeBundle(dir, 'refactor-module', []);
      const text = bundle!.deliverables[0]!.text;
      expect(text).toContain(`#### ${edited!.path} (changed)`);
      expect(text).toContain('// the delivered refactor');
      expect(text).toContain('#### src/lib/helper.js (added)');
      expect(text).toMatch(new RegExp(`Unchanged: .*${untouched!.path}`));
      expect(text).not.toContain('installed');
      expect(text).not.toContain('lockfileVersion');
      // The workspace copy of an edited file is the change, not its source.
      const source = bundle!.sources.find((s) => s.label === edited!.path);
      expect(source?.text).toBe(edited!.content);

      expect(await trialHasFolderDeliverable(dir, 'refactor-module')).toBe(true);
      const v2 = {
        model: 'm',
        promptVersion: 2,
        samples: [{ scores: { fitness: 0, completeness: 0, grounding: 0, craft: 0 }, reasons: '' }],
      };
      expect(isCurrentJudgeReport(v2)).toBe(false);
      expect(isCurrentJudgeReport(v2, { folderDeliverable: true })).toBe(false);
      expect(isCurrentJudgeReport(v2, { folderDeliverable: false })).toBe(true);
    });

    it('mutates only the lines the work changed, never imports', async () => {
      const { changedLines, mutants } = await import('./code-defects.ts');
      const seed = "import { x } from './x.js';\nexport const same = a === b;\n";
      const text = `${seed}export const fresh = c === d;\n`;
      const changed = changedLines(text, seed);
      expect([...changed]).toEqual([2]);
      const all = [...mutants(text, changed)];
      expect(all).toContain(`${seed}export const fresh = c !== d;\n`);
      expect(all.every((m) => m.startsWith(seed))).toBe(true);
      expect([...mutants(text, new Set([0]))]).toEqual([]);
    });

    it('plants code defects the project’s own tests confirm', async () => {
      const { copyTrial, plantFolderDefect } = await import('./code-defects.ts');
      const { loadCraftbookTestSpecsSync } = await import('../craftbooks/test-spec-loader.ts');
      const book = loadCraftbookTestSpecsSync().find((s) => s.craftbookId === 'refactor-module');
      const seed = book?.spec.setup.files ?? [];
      const format = seed.find((f) => f.path === 'src/format-name.js');
      expect(format?.content).toContain('toUpperCase');
      const folderTask = {
        ...task,
        craftbook: {
          ...task.craftbook,
          id: 'refactor-module',
          version: book!.version,
          contract: {
            goal: 'Restructure the module without changing behavior.',
            deliverables: [
              { id: 'code', path: './', kind: 'code-module', description: 'The source' },
            ],
            criteria: [],
          },
        },
      } as unknown as Task;
      dir = await mkdtemp(join(tmpdir(), 'gezel-strategy-defect-'));
      await writeFile(join(dir, 'state.json'), JSON.stringify({ tasks: { tasks: [folderTask] } }));
      const ws = join(dir, 'workspace', 'p');
      for (const f of seed.filter((f) => f.surface !== 'harness' && f.surface !== 'artifact')) {
        await mkdir(join(ws, f.path, '..'), { recursive: true });
        await writeFile(join(ws, f.path), f.content);
      }
      const delivered =
        "export function formatName(raw) {\n  return String(raw).trim().split(/\\s+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');\n}\n";
      await writeFile(join(ws, 'src', 'format-name.js'), delivered);

      const broken = await copyTrial(dir, 'refactor-module', join(dir, 'broken'));
      const planted = await plantFolderDefect(broken!, 'behavior-broken');
      expect(planted).toMatchObject({ testsBefore: true, testsAfter: false });
      expect(planted!.note).toMatch(/^src\/format-name\.js: /);

      const undone = await copyTrial(dir, 'refactor-module', join(dir, 'undone'));
      expect(await plantFolderDefect(undone!, 'change-undone')).toMatchObject({
        note: 'src/format-name.js restored to its starting version',
        testsAfter: true,
      });
      // Tests are promised only by a code-with-tests deliverable.
      const plain = await copyTrial(dir, 'refactor-module', join(dir, 'plain'));
      expect(await plantFolderDefect(plain!, 'tests-removed')).toBeNull();
      // Nothing in the original trial changed.
      const { readFile } = await import('node:fs/promises');
      expect(await readFile(join(ws, 'src', 'format-name.js'), 'utf8')).toBe(delivered);
    });
  });
});

describe('round-2 arms and engine metrics', () => {
  it('parses the auto and contract-ablation arms', () => {
    expect(parseStrategyArms('auto,harness,contract-shown,outcome-bare')).toEqual([
      { arm: 'auto', strategy: 'auto' },
      { arm: 'harness', strategy: 'outcome', options: { procedure: 'none', contract: 'hidden' } },
      {
        arm: 'contract-shown',
        strategy: 'outcome',
        options: { procedure: 'none', contract: 'shown' },
      },
      { arm: 'outcome-bare', strategy: 'outcome', options: { procedure: 'none' } },
    ]);
  });

  it('reads context size, engine speed and the resolved strategy from the daemon log', () => {
    const log = [
      'INFO  [tasks] [tasks] default/1 generalist-mode resolved=stepwise setting=auto provider=llama-cpp tier=tiny requested=auto strategy=stepwise',
      'INFO  [tasks] [tasks] eval-proj/1 generalist-mode resolved=generalist setting=auto provider=llama-cpp tier=medium requested=auto owner=g1 strategy=outcome source=model procedure=none',
      '[llama-server] slot print_timing: id  0 | task 0 | prompt processing, n_tokens =   4002, progress = 0.85, t =   4.57 s / 876.00 tokens per second',
      '[llama-server] slot print_timing: id  0 | task 0 | n_gen =    100, tg =  32.38 t/s, tg_3s =  32.70 t/s',
      '[llama-server] slot print_timing: id  0 | task 0 | n_gen =    176, tg =  28.43 t/s, tg_3s =  24.53 t/s',
      '[llama-server] slot      release: id  0 | task 0 | stop processing: n_tokens = 5120, truncated = 0',
      '[llama-server] slot      release: id  0 | task 1 | stop processing: n_tokens = 31200, truncated = 0',
      '[llama-server] slot      release: id  0 | task 2 | stop processing: n_tokens = 38900, truncated = 0',
      'DEBUG [mcp-bridge] [llama-cpp] model-facing tool surface has 22 tools after role/provider filtering: search_memory',
      'DEBUG [mcp-bridge] [llama-cpp] model-facing tool surface has 44 tools after role/provider filtering: search_memory',
    ].join('\n');
    expect(parseEngineMetrics(log, 'eval-proj/1')).toEqual({
      peakPromptTokens: 38900,
      firstPromptTokens: 31200,
      peakToolSurface: 44,
      decodeTps: 30.405,
      prefillTps: 876,
      resolvedStrategy: 'outcome',
      resolvedSource: 'model',
    });
    expect(parseEngineMetrics('', 'eval-proj/1').resolvedStrategy).toBeNull();
  });
});

describe('pi arm', () => {
  it('describes the model to pi the way Gezel’s pi setup does', async () => {
    const { piModelsJson } = await import('./pi-harness.ts');
    const config = JSON.parse(
      piModelsJson({
        baseUrl: 'https://127.0.0.1:6228/',
        token: 't0k',
        model: { id: 'llama-cpp:qwen3.8-27b-q4', contextWindow: 262_144, supportsReasoning: true },
      }),
    );
    const provider = config.providers.gezel;
    expect(provider).toMatchObject({
      baseUrl: 'https://127.0.0.1:6228/v1',
      api: 'openai-completions',
      apiKey: 't0k',
    });
    expect(provider.models[0]).toMatchObject({
      id: 'llama-cpp:qwen3.8-27b-q4',
      reasoning: true,
      contextWindow: 262_144,
      maxTokens: 32_768,
    });
  });

  it('confines pi to the workspace and its own state', async () => {
    const { sandboxedCommand } = await import('./pi-harness.ts');
    const { args } = sandboxedCommand({
      piBin: '/opt/pi',
      nodeBin: '/opt/node/bin/node',
      workspace: '/tmp/home-x/projects/p/workspace',
      stateDir: '/home/me/runs/t/pi',
      args: ['--mode', 'json', 'do it'],
    });
    const at = (flag: string, value: string) =>
      args.findIndex((a, i) => a === flag && args[i + 1] === value);
    expect(at('--ro-bind', '/')).toBe(0);
    // Hiding /home and /tmp must come before the binds that reopen the trial's folders.
    expect(at('--tmpfs', '/home')).toBeLessThan(at('--bind', '/home/me/runs/t/pi'));
    expect(at('--tmpfs', '/tmp')).toBeLessThan(at('--bind', '/tmp/home-x/projects/p/workspace'));
    expect(args.slice(-3)).toEqual(['--mode', 'json', 'do it']);
  });

  it('gives pi the book description only on the pi-book arm', async () => {
    const { piPromptAppendix } = await import('./pi-harness.ts');
    const { STRATEGY_ARMS } = await import('./books.ts');
    expect(piPromptAppendix({ about: 'A studio.' })).toBe('## About this project\n\nA studio.');
    expect(piPromptAppendix({})).toBeUndefined();
    const both = piPromptAppendix({
      about: 'A studio.',
      book: { name: 'Monthly Invoice Run', description: 'One HTML invoice per client.' },
    });
    expect(both).toContain('## About this project\n\nA studio.');
    expect(both).toContain(
      'This request comes with the **Monthly Invoice Run** craftbook. One HTML invoice per client.',
    );
    expect(
      piPromptAppendix({ about: 'A studio.', missionObjectives: 'Numbering never skips.' }),
    ).toBe('## About this project\n\nA studio.\n\n## Mission objectives\n\nNumbering never skips.');
    expect(STRATEGY_ARMS.pi?.bookDescription).toBeUndefined();
    expect(STRATEGY_ARMS['pi-book']).toMatchObject({ harness: 'pi', bookDescription: true });
  });

  it('runs OpenCode offline on the managed config, with the same appendix as pi', async () => {
    const { openCodeOverlay, sandboxedOpenCodeCommand, countOpenCodeEvent } = await import(
      './opencode-harness.ts'
    );
    const { STRATEGY_ARMS } = await import('./books.ts');
    expect(JSON.parse(openCodeOverlay({ instructionsPath: '/s/instructions.md' }))).toEqual({
      instructions: ['/s/instructions.md'],
      permission: { webfetch: 'deny', websearch: 'deny' },
    });
    expect(JSON.parse(openCodeOverlay({}))).not.toHaveProperty('instructions');

    const cmd = sandboxedOpenCodeCommand({
      opencodeBin: '/tools/oc/bin/opencode',
      nodeBin: '/node/bin/node',
      workspace: '/runs/t/ws',
      stateDir: '/runs/t/opencode',
      integrationDir: '/runs/t/home/integrations/opencode',
      rgDir: '/tools/rg/bin',
      args: ['run', 'hello'],
      hidden: ['--tmpfs', '/var/lib/gezel'],
    });
    const pairs = (flag: string) =>
      cmd.args.flatMap((a, i) => (a === flag ? [cmd.args[i + 1]] : []));
    expect(pairs('--tmpfs')).toEqual(['/home', '/root', '/tmp', '/var/lib/gezel']);
    const { hiddenPathArgs } = await import('./pi-harness.ts');
    expect(hiddenPathArgs((path) => path === '/var/lib/gezel')).toEqual(['--tmpfs', '/var/lib/gezel']);
    expect(hiddenPathArgs(() => false)).toEqual([]);
    expect(pairs('--ro-bind')).toEqual(
      expect.arrayContaining(['/tools/oc/bin', '/tools/rg/bin', '/runs/t/home/integrations/opencode']),
    );
    expect(pairs('--bind')).toEqual(['/runs/t/ws', '/runs/t/opencode']);
    expect(cmd.args.slice(cmd.args.indexOf('--') + 1)).toEqual([
      '/tools/oc/bin/opencode',
      'run',
      'hello',
    ]);

    const state = { running: true, exitCode: null, turns: 0, toolCalls: 0 };
    for (const line of [
      '{"type":"step_start"}',
      '{"type":"tool_use","part":{"tool":"write"}}',
      '{"type":"step_finish"}',
      'not json',
      '{"type":"error","error":{"message":"boom"}}',
    ]) {
      countOpenCodeEvent(state, line);
    }
    expect(state).toMatchObject({ turns: 1, toolCalls: 1 });
    expect((state as { error?: string }).error).toContain('boom');

    expect(STRATEGY_ARMS.opencode).toMatchObject({ harness: 'opencode' });
    expect(STRATEGY_ARMS.opencode?.bookDescription).toBeUndefined();
    expect(STRATEGY_ARMS['opencode-book']).toMatchObject({
      harness: 'opencode',
      bookDescription: true,
    });
  });
});
