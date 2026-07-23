import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverScoredTrials } from './bin/compare-scores.ts';
import {
  buildModelCoverage,
  discoverCachedModelInventory,
  discoverCachedModels,
  renderModelCoverageReport,
} from './bin/model-coverage.ts';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'gezel-model-coverage-test-'));
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

async function makeModel(
  root: string,
  id: string,
  manifestExtras: Record<string, unknown> = {},
): Promise<void> {
  await mkdir(join(root, id), { recursive: true });
  await writeFile(join(root, id, `${id}.gguf`), '');
  await writeFile(
    join(root, id, 'manifest.json'),
    JSON.stringify({ weightsFilename: `${id}.gguf`, ...manifestExtras }),
  );
}

async function makeDs4Model(root: string, id: string): Promise<void> {
  await mkdir(join(root, id), { recursive: true });
  await writeFile(join(root, id, `${id}.gguf`), '');
  await writeFile(
    join(root, id, 'manifest.json'),
    JSON.stringify({ engine: 'ds4', filename: `${id}.gguf` }),
  );
}

async function writeTrial(opts: {
  dir: string;
  modelId: string;
  scenarioId: string;
  startedAt: string;
  composite: number;
}): Promise<void> {
  await mkdir(opts.dir, { recursive: true });
  await writeFile(
    join(opts.dir, 'result.json'),
    JSON.stringify({
      modelId: opts.modelId,
      scenarioId: opts.scenarioId,
      startedAt: opts.startedAt,
      success: opts.composite >= 8,
    }),
  );
  await writeFile(
    join(opts.dir, 'postmortem.md'),
    `# Trial postmortem\n\n**Composite: ${opts.composite.toFixed(1)} / 10** (band: ship-ready)\n`,
  );
}

describe('discoverCachedModels', () => {
  it('deduplicates model ids across roots and tracks every root', async () => {
    const rootA = join(tempRoot, 'root-a');
    const rootB = join(tempRoot, 'root-b');
    await makeModel(rootA, 'llama3.2');
    await makeModel(rootA, 'gemma4-31b-q4');
    await makeModel(rootB, 'gemma4-31b-q4');

    const models = discoverCachedModels([rootA, rootB]);

    expect(models).toEqual([
      expect.objectContaining({
        id: 'gemma4-31b-q4',
        canonicalId: 'gemma4-31b',
        roots: [rootA, rootB],
      }),
      expect.objectContaining({
        id: 'llama3.2',
        canonicalId: 'llama3.2',
        roots: [rootA],
      }),
    ]);
  });

  it('ignores unusable cache directories without readable weights', async () => {
    const root = join(tempRoot, 'models');
    await makeModel(root, 'usable-q4');
    await mkdir(join(root, 'missing-manifest'), { recursive: true });
    await mkdir(join(root, 'missing-weight'), { recursive: true });
    await writeFile(
      join(root, 'missing-weight', 'manifest.json'),
      JSON.stringify({ weightsFilename: 'missing.gguf' }),
    );

    expect(discoverCachedModels([root])).toEqual([
      expect.objectContaining({
        id: 'usable-q4',
        canonicalId: 'usable',
      }),
    ]);
  });

  it('excludes cached models that the current llama.cpp runtime cannot load', async () => {
    const root = join(tempRoot, 'models');
    await makeModel(root, 'usable-q4', { architecture: 'llama' });
    await makeModel(root, 'deepseek-v4-flash-284b-q2', { architecture: 'deepseek4' });

    const inventory = discoverCachedModelInventory([root]);

    expect(inventory.cachedModels).toEqual([
      expect.objectContaining({
        id: 'usable-q4',
        canonicalId: 'usable',
      }),
    ]);
    expect(inventory.excludedCachedModels).toEqual([
      {
        id: 'deepseek-v4-flash-284b-q2',
        engine: 'llama-cpp',
        roots: [root],
        reason: 'unsupported by current llama.cpp binary: architecture deepseek4',
      },
    ]);
  });

  it('keeps a DeepSeek-V4 ds4 install usable while excluding its llama.cpp copy', async () => {
    const llamaRoot = join(tempRoot, 'engines', 'llama-cpp', 'models');
    const ds4Root = join(tempRoot, 'engines', 'ds4', 'models');
    await makeModel(llamaRoot, 'deepseek-v4-flash-284b-q2', { architecture: 'deepseek4' });
    await makeDs4Model(ds4Root, 'deepseek-v4-flash-284b-q2');

    const inventory = discoverCachedModelInventory([llamaRoot, ds4Root]);

    expect(inventory.cachedModels).toEqual([
      expect.objectContaining({
        id: 'deepseek-v4-flash-284b-q2',
        engine: 'ds4',
        roots: [ds4Root],
      }),
    ]);
    expect(inventory.excludedCachedModels).toEqual([
      expect.objectContaining({
        id: 'deepseek-v4-flash-284b-q2',
        engine: 'llama-cpp',
        roots: [llamaRoot],
      }),
    ]);
  });
});

describe('buildModelCoverage', () => {
  it('reports post-cutoff and comparable-pair coverage per cached model', async () => {
    const modelRoot = join(tempRoot, 'models');
    const runsRoot = join(tempRoot, 'runs');
    await makeModel(modelRoot, 'gemma4-31b-q4');
    await makeModel(modelRoot, 'mistral-medium-3.5-128b-q4');

    await writeTrial({
      dir: join(runsRoot, 'pre-gemma'),
      modelId: 'gemma4-31b',
      scenarioId: 'incident-postmortem',
      startedAt: '2026-06-04T00:00:00.000Z',
      composite: 3.5,
    });
    await writeTrial({
      dir: join(runsRoot, 'post-gemma'),
      modelId: 'gemma4-31b-q4',
      scenarioId: 'incident-postmortem',
      startedAt: '2026-06-05T00:00:00.000Z',
      composite: 10,
    });

    const cachedModels = discoverCachedModels([modelRoot]);
    const trials = discoverScoredTrials(runsRoot);
    const coverage = buildModelCoverage({
      cachedModels,
      trials,
      cutoffIso: '2026-06-05T00:00:00Z',
    });

    expect(coverage.rows).toEqual([
      expect.objectContaining({
        modelId: 'gemma4-31b-q4',
        postTrialCount: 1,
        postScenarioCount: 1,
        comparablePairCount: 1,
        passingComparablePairCount: 1,
        latestPostComposite: 10,
        scenariosPostCutoff: ['incident-postmortem'],
      }),
      expect.objectContaining({
        modelId: 'mistral-medium-3.5-128b-q4',
        postTrialCount: 0,
        postScenarioCount: 0,
        comparablePairCount: 0,
        latestPostComposite: null,
        scenariosPostCutoff: [],
      }),
    ]);
  });

  it('does not count q4 post-cutoff evidence as exact coverage for q8 variants', async () => {
    const coverage = buildModelCoverage({
      cachedModels: [
        { id: 'qwen3.6-27b-q4', canonicalId: 'qwen3.6', roots: ['/models'] },
        { id: 'qwen3.6-27b-q8', canonicalId: 'qwen3.6', roots: ['/models'] },
      ],
      trials: [
        {
          dir: '/runs/pre',
          modelId: 'qwen3.6',
          scenarioId: 'tankcombat',
          startedAt: '2026-06-04T00:00:00.000Z',
          composite: 9,
          success: true,
        },
        {
          dir: '/runs/post',
          modelId: 'qwen3.6-27b-q4',
          scenarioId: 'tankcombat',
          startedAt: '2026-06-05T00:00:00.000Z',
          composite: 10,
          success: true,
        },
      ],
      cutoffIso: '2026-06-05T00:00:00Z',
    });

    expect(coverage.rows.find((row) => row.modelId === 'qwen3.6-27b-q4')).toMatchObject({
      postTrialCount: 1,
      postScenarioCount: 1,
      comparablePairCount: 1,
    });
    expect(coverage.rows.find((row) => row.modelId === 'qwen3.6-27b-q8')).toMatchObject({
      postTrialCount: 0,
      postScenarioCount: 0,
      comparablePairCount: 0,
    });
  });

  it('counts narrow historical bare-id post aliases for q4 cached models', async () => {
    const coverage = buildModelCoverage({
      cachedModels: [
        { id: 'nemotron3-super-120b-q4', canonicalId: 'nemotron3-super-120b', roots: ['/models'] },
      ],
      trials: [
        {
          dir: '/runs/post',
          modelId: 'nemotron3-super-120b',
          scenarioId: 'tictactoe',
          startedAt: '2026-06-05T00:00:00.000Z',
          composite: 10,
          success: true,
        },
      ],
      cutoffIso: '2026-06-05T00:00:00Z',
    });

    expect(coverage.rows[0]).toMatchObject({
      postTrialCount: 1,
      postScenarioCount: 1,
      latestPostComposite: 10,
    });
  });

  it('renders missing cached models in the markdown report', async () => {
    const coverage = buildModelCoverage({
      cachedModels: [
        { id: 'covered-q4', canonicalId: 'covered', roots: ['/models'] },
        { id: 'missing-q4', canonicalId: 'missing', roots: ['/models'] },
      ],
      trials: [
        {
          dir: '/runs/post',
          modelId: 'covered-q4',
          scenarioId: 'tictactoe',
          startedAt: '2026-06-05T00:00:00.000Z',
          composite: 9,
          success: true,
        },
      ],
      cutoffIso: '2026-06-05T00:00:00Z',
    });

    const markdown = renderModelCoverageReport(coverage);

    expect(markdown).toContain('| Models with post-cutoff scored trials | 1 / 2 |');
    expect(markdown).toContain('| missing-q4 | llama-cpp | tiny | missing | 0 | 0 | 0 | - | - |');
  });

  it('renders runtime-unsupported cached models outside the usable denominator', async () => {
    const coverage = buildModelCoverage({
      cachedModels: [{ id: 'covered-q4', canonicalId: 'covered', roots: ['/models'] }],
      excludedCachedModels: [
        {
          id: 'deepseek-v4-flash-284b-q2',
          roots: ['/models'],
          reason: 'unsupported by current llama.cpp binary: architecture deepseek4',
        },
      ],
      trials: [
        {
          dir: '/runs/post',
          modelId: 'covered-q4',
          scenarioId: 'tictactoe',
          startedAt: '2026-06-05T00:00:00.000Z',
          composite: 9,
          success: true,
        },
      ],
      cutoffIso: '2026-06-05T00:00:00Z',
    });

    const markdown = renderModelCoverageReport(coverage);

    expect(markdown).toContain('| Usable cached model installs | 1 |');
    expect(markdown).toContain(
      '| deepseek-v4-flash-284b-q2 | llama-cpp | unsupported by current llama.cpp binary: architecture deepseek4 |',
    );
  });
});
