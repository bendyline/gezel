import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type ScoredTrial,
  canonicalModelId,
  compareScores,
  discoverScoredTrials,
  renderMarkdownReport,
} from './bin/compare-scores.ts';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'gezel-compare-scores-test-'));
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

async function writeTrial(opts: {
  dir: string;
  modelId: string;
  scenarioId: string;
  startedAt: string;
  composite: number;
  success?: boolean;
}): Promise<void> {
  await mkdir(opts.dir, { recursive: true });
  await writeFile(
    join(opts.dir, 'facts.json'),
    JSON.stringify({
      modelId: opts.modelId,
      scenarioId: opts.scenarioId,
      timing: { startedAt: opts.startedAt },
      outcome: { success: opts.success ?? opts.composite >= 8 },
    }),
  );
  await writeFile(
    join(opts.dir, 'postmortem.md'),
    `# Trial postmortem\n\n**Composite: ${opts.composite.toFixed(1)} / 10** (band: ship-ready)\n`,
  );
}

describe('discoverScoredTrials', () => {
  it('finds scored trial directories and ignores workspace deliverable postmortems', async () => {
    await writeTrial({
      dir: join(tempRoot, 'runs', 'trial-a'),
      modelId: 'llama3.2',
      scenarioId: 'tictactoe',
      startedAt: '2026-06-05T01:00:00.000Z',
      composite: 9.5,
    });
    await mkdir(join(tempRoot, 'runs', 'trial-b', 'workspace', 'checkout'), {
      recursive: true,
    });
    await writeFile(
      join(tempRoot, 'runs', 'trial-b', 'workspace', 'checkout', 'postmortem.md'),
      '# User-facing incident postmortem\n',
    );

    const trials = discoverScoredTrials(join(tempRoot, 'runs'));

    expect(trials).toHaveLength(1);
    expect(trials[0]).toMatchObject({
      modelId: 'llama3.2',
      scenarioId: 'tictactoe',
      composite: 9.5,
    });
  });

  it('uses result.json metadata when a scored trial has no facts.json yet', async () => {
    const dir = join(tempRoot, 'runs', 'trial-result-only');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'result.json'),
      JSON.stringify({
        modelId: 'gemma4-31b-q4',
        scenarioId: 'incident-postmortem',
        startedAt: '2026-06-05T02:00:00.000Z',
        success: true,
      }),
    );
    await writeFile(
      join(dir, 'postmortem.md'),
      '# Trial postmortem\n\n**Composite: 10.0 / 10** (band: ship-ready)\n',
    );

    expect(discoverScoredTrials(join(tempRoot, 'runs'))).toEqual([
      expect.objectContaining({
        modelId: 'gemma4-31b-q4',
        scenarioId: 'incident-postmortem',
        startedAt: '2026-06-05T02:00:00.000Z',
        composite: 10,
      }),
    ]);
  });
});

describe('compareScores', () => {
  it('compares latest pre-cutoff and post-cutoff trial per model/scenario pair', () => {
    const trials: ScoredTrial[] = [
      {
        dir: '/runs/old-pre',
        modelId: 'model-a',
        scenarioId: 'repair',
        startedAt: '2026-06-01T00:00:00.000Z',
        composite: 4,
        success: false,
      },
      {
        dir: '/runs/latest-pre',
        modelId: 'model-a',
        scenarioId: 'repair',
        startedAt: '2026-06-04T00:00:00.000Z',
        composite: 5,
        success: false,
      },
      {
        dir: '/runs/post',
        modelId: 'model-a',
        scenarioId: 'repair',
        startedAt: '2026-06-05T01:00:00.000Z',
        composite: 9,
        success: true,
      },
      {
        dir: '/runs/post-only',
        modelId: 'model-b',
        scenarioId: 'repair',
        startedAt: '2026-06-05T02:00:00.000Z',
        composite: 10,
        success: true,
      },
    ];

    const comparison = compareScores(trials, '2026-06-05T00:00:00Z');

    expect(comparison.sourceCount).toBe(4);
    expect(comparison.comparablePairs).toHaveLength(1);
    expect(comparison.averagePre).toBe(5);
    expect(comparison.averagePost).toBe(9);
    expect(comparison.averageDelta).toBe(4);
    expect(comparison.relativeLift).toBe(80);
    expect(comparison.passingPre).toBe(0);
    expect(comparison.passingPost).toBe(1);
  });

  it('compares known historical model aliases against explicit catalog ids', () => {
    const comparison = compareScores(
      [
        {
          dir: '/runs/pre',
          modelId: 'gemma4-31b',
          scenarioId: 'incident-postmortem',
          startedAt: '2026-06-04T00:00:00.000Z',
          composite: 3.5,
          success: false,
        },
        {
          dir: '/runs/post',
          modelId: 'gemma4-31b-q4',
          scenarioId: 'incident-postmortem',
          startedAt: '2026-06-05T00:00:00.000Z',
          composite: 10,
          success: true,
        },
      ],
      '2026-06-05T00:00:00Z',
    );

    expect(comparison.comparablePairs).toHaveLength(1);
    expect(comparison.comparablePairs[0]).toMatchObject({
      modelId: 'gemma4-31b-q4',
      scenarioId: 'incident-postmortem',
      delta: 6.5,
    });
  });

  it('excludes reference models (mistral-7b, nemotron-super) from the headline aggregate', () => {
    const mk = (modelId: string, pre: number, post: number): ScoredTrial[] => [
      {
        dir: `/pre/${modelId}`,
        modelId,
        scenarioId: 'repair',
        startedAt: '2026-06-04T00:00:00.000Z',
        composite: pre,
        success: false,
      },
      {
        dir: `/post/${modelId}`,
        modelId,
        scenarioId: 'repair',
        startedAt: '2026-06-05T00:00:00.000Z',
        composite: post,
        success: post >= 8,
      },
    ];
    const comparison = compareScores(
      [
        ...mk('gemma4-e4b-q8', 8, 10), // primary
        ...mk('mistral-7b-q4', 0, 0), // reference (weak base)
        ...mk('nemotron3-super-120b-q4', 0, 0), // reference (slow host)
      ],
      '2026-06-05T00:00:00Z',
    );
    // Headline reflects ONLY the primary cohort, not the 0/0 reference models.
    expect(comparison.primaryPairCount).toBe(1);
    expect(comparison.referencePairCount).toBe(2);
    expect(comparison.averagePost).toBe(10);
    expect(comparison.passingPost).toBe(1);
    expect(comparison.referenceAveragePost).toBe(0);
    expect(comparison.referencePassingPost).toBe(0);
    expect(comparison.comparablePairs.find((p) => p.modelId === 'mistral-7b-q4')?.cohort).toBe(
      'reference',
    );
  });

  it('renders a markdown report with aggregate and pair details', () => {
    const comparison = compareScores(
      [
        {
          dir: '/runs/pre',
          modelId: 'model-a',
          scenarioId: 'repair',
          startedAt: '2026-06-04T00:00:00.000Z',
          composite: 7.5,
          success: false,
        },
        {
          dir: '/runs/post',
          modelId: 'model-a',
          scenarioId: 'repair',
          startedAt: '2026-06-05T00:00:00.000Z',
          composite: 8.5,
          success: true,
        },
      ],
      '2026-06-05T00:00:00Z',
    );

    expect(renderMarkdownReport(comparison)).toContain(
      '| model-a | ? | primary | repair | 7.5 | 8.5 | +1.0 | no -> yes |',
    );
  });
});

describe('canonicalModelId', () => {
  it('strips quantization suffixes but preserves architecture tags', () => {
    expect(canonicalModelId('gemma4-31b-q4')).toBe('gemma4-31b');
    expect(canonicalModelId('qwen3.6-35b-a3b-q8')).toBe('qwen3.6-35b-a3b');
  });

  it('bridges known historical aliases', () => {
    expect(canonicalModelId('mistral-7b-q4')).toBe('mistral');
    expect(canonicalModelId('qwen3.6-27b-q4')).toBe('qwen3.6');
  });
});
