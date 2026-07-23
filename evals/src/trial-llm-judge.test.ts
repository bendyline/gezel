import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runLlmJudge } from './llm-judge.ts';
import { writeTrialFacts } from './trial-facts.ts';
import { maybeJudgeTrial } from './trial-llm-judge.ts';

vi.mock('./llm-judge.ts', () => ({
  runLlmJudge: vi.fn(),
}));

const runLlmJudgeMock = vi.mocked(runLlmJudge);
let tempRoot: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'gezel-evals-judge-test-'));
  runLlmJudgeMock.mockReset();
  await mkdir(join(tempRoot, 'workspace'), { recursive: true });
  await writeFile(
    join(tempRoot, 'result.json'),
    JSON.stringify({
      trialId: 'judge-trial',
      scenarioId: 'tictactoe',
      modelId: 'gemma4-e4b-q8',
      startedAt: '2026-07-10T00:00:00.000Z',
      finishedAt: '2026-07-10T00:00:01.000Z',
      durationMs: 1000,
      success: true,
      reason: 'passed',
      runDir: tempRoot,
    }),
  );
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe('single-trial LLM judge facts refresh', () => {
  it('regenerates facts.json after persisting llm-judge.json', async () => {
    await writeFile(join(tempRoot, 'workspace', 'index.html'), '<html><h1>Game</h1></html>');
    await writeTrialFacts(tempRoot);
    const before = JSON.parse(await readFile(join(tempRoot, 'facts.json'), 'utf8'));
    expect(before.judge).toBeUndefined();

    const report = {
      judgeModel: 'gpt-test',
      judgeProvider: 'openai' as const,
      scenarioId: 'tictactoe',
      scoreAxes: {
        visualQuality: 8,
        functionalCompleteness: 9,
        codeQuality: 7,
        polish: 8,
      },
      meanScore: 8,
      justification: 'Complete and polished.',
      durationMs: 25,
    };
    runLlmJudgeMock.mockResolvedValue(report);

    const wrote = await maybeJudgeTrial({
      scenario: {
        id: 'tictactoe',
        prompt: 'Build a game.',
        description: 'A playable game.',
      },
      runDir: tempRoot,
      log: vi.fn(),
    });

    expect(wrote).toBe(true);
    expect(runLlmJudgeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        scenarioId: 'tictactoe',
        userPrompt: 'Build a game.',
        artifact: '<html><h1>Game</h1></html>',
      }),
    );
    expect(JSON.parse(await readFile(join(tempRoot, 'llm-judge.json'), 'utf8'))).toEqual(report);
    const after = JSON.parse(await readFile(join(tempRoot, 'facts.json'), 'utf8'));
    expect(after.judge).toEqual(report);
  });

  it('does not call the judge or rewrite facts when no HTML artifact exists', async () => {
    await writeTrialFacts(tempRoot);
    const factsBefore = await readFile(join(tempRoot, 'facts.json'), 'utf8');
    const log = vi.fn();

    const wrote = await maybeJudgeTrial({
      scenario: {
        id: 'tictactoe',
        prompt: 'Build a game.',
        description: 'A playable game.',
      },
      runDir: tempRoot,
      log,
    });

    expect(wrote).toBe(false);
    expect(runLlmJudgeMock).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      '[llm-judge] no HTML artifact in trial dir — skipping advisory judge',
    );
    expect(await readFile(join(tempRoot, 'facts.json'), 'utf8')).toBe(factsBefore);
  });

  it('judges a named Markdown artifact with scenario-specific axes and context', async () => {
    await writeFile(join(tempRoot, 'workspace', 'story.md'), '# The Story\n\nA winter scene.');
    const report = {
      judgeModel: 'gpt-test',
      judgeProvider: 'openai' as const,
      scenarioId: 'fantasy-fiction',
      scoreAxes: { originality: 8, proseQuality: 7 },
      meanScore: 7.5,
      justification: 'Specific and controlled.',
      durationMs: 20,
    };
    runLlmJudgeMock.mockResolvedValue(report);

    const axes = [
      { name: 'originality', description: 'Specific, surprising choices.' },
      { name: 'proseQuality', description: 'Sentence-level quality.' },
    ];
    const wrote = await maybeJudgeTrial({
      scenario: {
        id: 'fantasy-fiction',
        prompt: 'Write a story.',
        description: 'A constrained fantasy story.',
        judge: {
          artifactBasename: 'story.md',
          artifactKind: 'markdown',
          axes,
          contextNote: 'The bargain price must be paid on the page.',
        },
      },
      runDir: tempRoot,
      log: vi.fn(),
    });

    expect(wrote).toBe(true);
    expect(runLlmJudgeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        scenarioId: 'fantasy-fiction',
        artifact: '# The Story\n\nA winter scene.',
        artifactKind: 'markdown',
        axisOverrides: axes,
        judgeContextNote: 'The bargain price must be paid on the page.',
      }),
    );
  });
});
